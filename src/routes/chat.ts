// ============================================================================
// 1min-bridge — POST /v1/chat/completions
// Supports: streaming SSE, non-streaming JSON, vision, tool calling,
//           feature suffixes (:online, :pdf, :summarize, :code),
//           UNIFY_CHAT_WITH_AI structured SSE, crawling filter
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { getModelData, isVisionModel } from "../model-registry.js";
import {
  callFeature,
  callFeatureStream,
  callFeatureStreamStructured,
  uploadAsset,
} from "../adapters/onemin.js";
import { invalidRequestError, modelNotFoundError, sendError } from "../errors.js";
import {
  buildToolSystemPrompt,
  parseToolCalls,
  stripToolCalls,
  type ChatTool,
} from "../adapters/tool-parser.js";
import type {
  Env,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  ChatContentPart,
} from "../types.js";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Crawling filter — 1min.ai injects unwanted UI text into responses
// ---------------------------------------------------------------------------

const CRAWL_PATTERNS = [
  /\[?\s*🌐\s*Crawling\s+site.*/gi,
  /\[?\s*🌐\s*Fetching.*/gi,
  /\[?\s*⚡\s*Extracting\s+content\s+from.*/gi,
  /Crawl\s+results?:.*/gi,
  /Fetching\s+results?\s+from\s+web.*/gi,
  /\[?\s*🔍\s*Searching.*/gi,
];

function filterCrawlingText(text: string): string {
  let filtered = text;
  for (const pattern of CRAWL_PATTERNS) {
    filtered = filtered.replace(pattern, "");
  }
  return filtered.trim();
}

function isCrawlStatus(text: string): boolean {
  return CRAWL_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

// ---------------------------------------------------------------------------
// Feature suffix mapping
// ---------------------------------------------------------------------------

const FEATURE_SUFFIX_MAP: Record<string, string> = {
  ":pdf": "CHAT_WITH_PDF",
  ":summarize": "SUMMARIZER",
  ":code": "CODE_GENERATOR",
  ":online": "CHAT_WITH_AI", // special: triggers webSearch flag
};

function resolveFeatureType(modelName: string): {
  featureType: string;
  cleanModel: string;
  webSearch: boolean;
} {
  for (const [suffix, featureType] of Object.entries(FEATURE_SUFFIX_MAP)) {
    if (modelName.endsWith(suffix)) {
      return {
        featureType: suffix === ":online" ? "CHAT_WITH_AI" : featureType,
        cleanModel: modelName.slice(0, -suffix.length),
        webSearch: suffix === ":online",
      };
    }
  }
  return {
    featureType: "CHAT_WITH_AI",
    cleanModel: modelName,
    webSearch: false,
  };
}

// ---------------------------------------------------------------------------
// Zod schema for request validation
// ---------------------------------------------------------------------------

const chatContentPartSchema = z.object({
  type: z.enum(["text", "image_url"]),
  text: z.string().optional(),
  image_url: z
    .object({
      url: z.string(),
      detail: z.enum(["low", "high", "auto"]).optional(),
    })
    .optional(),
});

const chatMessageSchema = z.object({
  role: z.union([
    z.literal("system"), z.literal("developer"), z.literal("user"),
    z.literal("assistant"), z.literal("tool"), z.literal("function"),
  ]),
  content: z.union([z.string(), z.array(chatContentPartSchema)]),
  name: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});

const toolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().min(1).max(4).optional(),
  response_format: z.object({ type: z.string() }).optional(),
  user: z.string().optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z
    .union([
      z.literal("auto"),
      z.literal("required"),
      z.literal("none"),
      z.object({
        type: z.literal("function"),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMessagesFor1Min(
  messages: ChatMessage[],
  toolSystemPrompt?: string,
): string {
  const parts: string[] = [];

  if (toolSystemPrompt) {
    parts.push(`System: ${toolSystemPrompt}`);
  }

  for (const m of messages) {
    const roleLabel =
      m.role === "system" || m.role === "developer"
        ? "System"
        : m.role === "assistant"
          ? "Assistant"
          : m.role === "tool" || m.role === "function"
            ? "Tool Result"
            : "Human";

    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter(
          (p): p is ChatContentPart & { type: "text" } => p.type === "text",
        )
        .map((p) => p.text ?? "")
        .join("\n");
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const toolCallsText = m.tool_calls
        .map(
          (tc) => `[Tool Call: ${tc.function.name}(${tc.function.arguments})]`,
        )
        .join("\n");
      text = text ? `${text}\n${toolCallsText}` : toolCallsText;
    }

    if (m.role === "tool" && m.tool_call_id) {
      text = `[Tool result for ${m.tool_call_id}]: ${text}`;
    }

    if (text) {
      parts.push(`${roleLabel}: ${text}`);
    }
  }

  return parts.join("\n\n");
}

function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "image_url"),
  );
}

async function extractImageUrls(
  apiKey: string,
  messages: ChatMessage[],
): Promise<string[]> {
  const urls: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "image_url" || !part.image_url?.url) continue;
      const url = await uploadAsset(apiKey, part.image_url.url, "image/png");
      urls.push(url);
    }
  }
  return urls;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function newChatId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// SSE streaming passthrough (with crawling filter + tool call support)
// ---------------------------------------------------------------------------

function buildStreamingResponse(
  upstream: Response,
  model: string,
  chatId: string,
): Response {
  const created = nowSec();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();

        const roleChunk: ChatCompletionChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`),
        );

        let buffer = "";
        let fullContent = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":")) continue;

              let content: string | null = null;

              if (trimmed.startsWith("data: ")) {
                const data = trimmed.slice(6);
                if (data === "[DONE]") continue;
                try {
                  const parsed: unknown = JSON.parse(data);
                  if (typeof parsed === "string") {
                    content = parsed;
                  } else if (
                    typeof parsed === "object" &&
                    parsed !== null &&
                    "choices" in parsed
                  ) {
                    const p = parsed as {
                      choices?: { delta?: { content?: string } }[];
                    };
                    if (p.choices?.[0]?.delta?.content) {
                      content = p.choices[0].delta.content;
                    }
                  } else if (
                    typeof parsed === "object" &&
                    parsed !== null &&
                    "content" in parsed
                  ) {
                    content = String(
                      (parsed as { content: unknown }).content,
                    );
                  } else if (
                    typeof parsed === "object" &&
                    parsed !== null &&
                    "text" in parsed
                  ) {
                    content = String((parsed as { text: unknown }).text);
                  }
                } catch {
                  content = data;
                }
              } else {
                content = trimmed;
              }

              // Crawling filter: skip crawl status messages
              if (content && isCrawlStatus(content)) {
                continue;
              }

              if (content) {
                // Also filter within multi-line content
                const filtered = filterCrawlingText(content);
                if (!filtered) continue;

                fullContent += filtered;
                const sseChunk: ChatCompletionChunk = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: filtered },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`),
                );
              }
            }
          }

          // Flush remaining buffer
          if (buffer.trim()) {
            const content = buffer.trim();
            if (content && !content.startsWith("data: [DONE]")) {
              const text = content.startsWith("data: ")
                ? content.slice(6)
                : content;
              const filtered = filterCrawlingText(text);
              if (filtered) {
                fullContent += filtered;
                const sseChunk: ChatCompletionChunk = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: filtered },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`),
                );
              }
            }
          }

          // Check for tool calls in full content
          const toolCalls = parseToolCalls(fullContent);
          if (toolCalls && toolCalls.length > 0) {
            const toolCallChunk: ChatCompletionChunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: toolCalls },
                  finish_reason: "tool_calls",
                },
              ],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(toolCallChunk)}\n\n`),
            );
          }
        } catch (err) {
          console.error("Stream read error:", err);
        }

        const hasToolCalls = parseToolCalls(fullContent) !== null;
        const finalChunk: ChatCompletionChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: hasToolCalls ? "tool_calls" : "stop",
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Request-Id": chatId,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

app.post("/v1/chat/completions", async (c) => {
  const apiKey = c.get("oneMinApiKey");

  let body: ChatCompletionRequest & {
    tools?: ChatTool[];
    tool_choice?: string;
  };
  try {
    const raw = await c.req.json();
    body = chatRequestSchema.parse(raw) as typeof body;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return sendError(c, invalidRequestError(`Validation error: ${msg}`));
    }
    return sendError(c, invalidRequestError("Invalid JSON body"));
  }

  const { messages, stream, tools, tool_choice } = body;

  // Resolve feature type from model suffix (e.g. gpt-4o:pdf, gpt-4o:online)
  const { featureType, cleanModel, webSearch } = resolveFeatureType(
    body.model,
  );

  // Validate model exists and is a chat model
  const modelData = await getModelData();
  if (!modelData.chatModelIds.includes(cleanModel)) {
    return sendError(c, modelNotFoundError(body.model));
  }

  // Handle vision — overrides feature type if images present
  const isVision = hasImageContent(messages);
  let imageList: string[] = [];
  let resolvedFeatureType = featureType;

  if (isVision) {
    if (!(await isVisionModel(cleanModel))) {
      return sendError(
        c,
        invalidRequestError(
          `Model '${cleanModel}' does not support image input`,
          "model_not_vision",
        ),
      );
    }
    resolvedFeatureType = "CHAT_WITH_IMAGE";
    imageList = await extractImageUrls(apiKey, messages);
  }

  // Tool calling: build system prompt injection
  let toolSystemPrompt: string | undefined;
  if (tools && tools.length > 0 && tool_choice !== "none") {
    toolSystemPrompt = buildToolSystemPrompt(tools, tool_choice);
  }

  const prompt = formatMessagesFor1Min(
    messages as ChatMessage[],
    toolSystemPrompt,
  );

  const payload = {
    type: resolvedFeatureType,
    model: cleanModel,
    promptObject: {
      prompt,
      isMixed: false,
      webSearch,
      ...(imageList.length > 0 ? { imageList } : {}),
      ...(body.temperature !== undefined
        ? { temperature: body.temperature }
        : {}),
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    },
  };

  const chatId = newChatId();

  try {
    if (stream) {
      // Try structured UNIFY_CHAT_WITH_AI first, fall back to legacy
      let streamBody: ReadableStream<Uint8Array> | null = null;
      if (resolvedFeatureType === "CHAT_WITH_AI" && !isVision) {
        try {
          streamBody = await callFeatureStreamStructured(apiKey, payload);
        } catch (err) {
          console.warn(
            "UNIFY_CHAT_WITH_AI failed, falling back to legacy:",
            (err as Error).message,
          );
        }
      }

      if (streamBody) {
        // Wrap the structured stream in a Response for the streaming handler
        const syntheticResponse = new Response(streamBody, {
          headers: { "Content-Type": "text/event-stream" },
        });
        return buildStreamingResponse(syntheticResponse, cleanModel, chatId);
      }

      // Fallback: legacy streaming
      const upstream = await callFeatureStream(apiKey, payload);
      return buildStreamingResponse(upstream, cleanModel, chatId);
    }

    // Non-streaming
    const data = await callFeature(apiKey, payload);
    const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
    let content = "";
    if (typeof resultObj === "string") {
      content = resultObj;
    } else if (
      Array.isArray(resultObj) &&
      typeof resultObj[0] === "string"
    ) {
      content = resultObj[0];
    } else if (resultObj && typeof resultObj === "object") {
      content = JSON.stringify(resultObj);
    }

    // Apply crawling filter to non-streaming responses too
    content = filterCrawlingText(content);

    // Parse tool calls
    const toolCalls = parseToolCalls(content);
    const finishReason =
      toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop";
    const cleanContent = toolCalls ? stripToolCalls(content) || null : content;

    const response: ChatCompletionResponse = {
      id: chatId,
      object: "chat.completion",
      created: nowSec(),
      model: cleanModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: cleanContent,
            ...(toolCalls && toolCalls.length > 0
              ? { tool_calls: toolCalls }
              : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(content),
        total_tokens: estimateTokens(prompt) + estimateTokens(content),
      },
    };

    return c.json(response);
  } catch (err) {
    console.error("Chat completion error:", err);
    throw err;
  }
});

export default app;
