// ============================================================================
// 1min-bridge — POST /v1/chat/completions
// Supports: streaming SSE, non-streaming JSON, vision, tool calling emulator,
//           ResponseSanitizer, feature suffixes (:online, :pdf, :summarize, :code),
//           UNIFY_CHAT_WITH_AI structured SSE, gpt-tokenizer token counts
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getModelData, isVisionModel } from "../model-registry.js";
import {
  callChat,
  callChatStream,
  uploadAsset,
} from "../adapters/onemin.js";
import { invalidRequestError, modelNotFoundError, sendError } from "../errors.js";
import {
  ToolCallingEmulator,
  type ToolDefinition,
} from "../adapters/tool-emulator.js";
import { ResponseSanitizer } from "../adapters/sanitizer.js";
import { calculateTokens } from "../utils/tokens.js";
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
// Feature suffix mapping
// ---------------------------------------------------------------------------

const FEATURE_SUFFIX_MAP: Record<string, string> = {
  ":pdf": "CHAT_WITH_PDF",
  ":summarize": "SUMMARIZER",
  ":code": "CODE_GENERATOR",
  ":online": "UNIFY_CHAT_WITH_AI", // special: triggers webSearch flag
};

function resolveFeatureType(modelName: string): {
  featureType: string;
  cleanModel: string;
  webSearch: boolean;
} {
  for (const [suffix, featureType] of Object.entries(FEATURE_SUFFIX_MAP)) {
    if (modelName.endsWith(suffix)) {
      return {
        featureType: suffix === ":online" ? "UNIFY_CHAT_WITH_AI" : featureType,
        cleanModel: modelName.slice(0, -suffix.length),
        webSearch: suffix === ":online",
      };
    }
  }
  return {
    featureType: "UNIFY_CHAT_WITH_AI",
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
    z.literal("system"),
    z.literal("developer"),
    z.literal("user"),
    z.literal("assistant"),
    z.literal("tool"),
    z.literal("function"),
  ]),
  content: z.union([z.string(), z.array(chatContentPartSchema), z.null(), z.unknown()]).optional(),
  name: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.literal("function").optional(),
        function: z.object({
          name: z.string(),
          arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
        }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});

const toolSchema = z.object({
  type: z.literal("function").optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  function: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().min(1).max(4).optional(),
  response_format: z.record(z.string(), z.unknown()).optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  user: z.string().optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMessagesFor1Min(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const m of messages) {
    if (m.role === "tool" || m.role === "function") {
      const cleanContent = ResponseSanitizer.unpackMemoryContent(m.content);
      const prefix = m.tool_call_id
        ? `[Contexto do Sistema - Informação Recuperada para ${m.tool_call_id}]:`
        : `[Contexto do Sistema - Informação Recuperada]:`;
      parts.push(`${prefix}\n${cleanContent}`);
      continue;
    }

    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const callsStr = m.tool_calls
        .map((tc) => {
          const fnName = tc.function?.name || "unnamed_tool";
          const fnArgs = tc.function?.arguments ?? "{}";
          const argsStr =
            typeof fnArgs === "string" ? fnArgs : JSON.stringify(fnArgs);
          return `${fnName}(${argsStr})`;
        })
        .join(", ");
      parts.push(`[Assistente consultou: ${callsStr}]`);
      continue;
    }

    const roleLabel =
      m.role === "system" || m.role === "developer"
        ? "System"
        : m.role === "assistant"
          ? "Assistant"
          : "Human";

    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter(
          (p): p is ChatContentPart & { type: "text" } =>
            Boolean(p && typeof p === "object" && p.type === "text"),
        )
        .map((p) => p.text ?? "")
        .join("\n");
    } else if (m.content) {
      text = ResponseSanitizer.unpackMemoryContent(m.content);
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
      m.content.some((p) => p && typeof p === "object" && p.type === "image_url"),
  );
}

async function extractImageUrls(
  apiKey: string,
  messages: ChatMessage[],
): Promise<string[]> {
  const uploadPromises: Promise<string>[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== "object" || part.type !== "image_url" || !part.image_url?.url) continue;
      uploadPromises.push(uploadAsset(apiKey, part.image_url.url, "image/png"));
    }
  }
  return Promise.all(uploadPromises);
}

function newChatId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// SSE streaming passthrough (with sanitizer + tool call support)
// ---------------------------------------------------------------------------

function buildStreamingResponse(
  upstream: Response,
  model: string,
  chatId: string,
  options?: {
    allowedTools?: ToolDefinition[];
    hasTools?: boolean;
    includeUsage?: boolean;
    promptTokens?: number;
  },
): Response {
  const created = nowSec();
  const hasTools = options?.hasTools ?? false;
  const allowedTools = options?.allowedTools;

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
        let pendingContentBuffer = "";

        const flushContent = (text: string) => {
          if (!text) return;
          const sseChunk: ChatCompletionChunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: text },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`),
          );
        };

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
                    content = String((parsed as { content: unknown }).content);
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

              if (content) {
                fullContent += content;

                if (hasTools) {
                  pendingContentBuffer += content;
                  if (!ToolCallingEmulator.isPotentialToolCallBuffer(pendingContentBuffer)) {
                    flushContent(pendingContentBuffer);
                    pendingContentBuffer = "";
                  }
                } else {
                  flushContent(content);
                }
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
              if (text) {
                fullContent += text;
                if (hasTools) {
                  pendingContentBuffer += text;
                  if (!ToolCallingEmulator.isPotentialToolCallBuffer(pendingContentBuffer)) {
                    flushContent(pendingContentBuffer);
                    pendingContentBuffer = "";
                  }
                } else {
                  flushContent(text);
                }
              }
            }
          }

          // Check for tool calls in full accumulated content
          const toolCalls = ToolCallingEmulator.parseResponse(fullContent, allowedTools);
          const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

          if (hasToolCalls) {
            const toolCallChunk: ChatCompletionChunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: ToolCallingEmulator.formatStreamingToolCalls(toolCalls),
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(toolCallChunk)}\n\n`),
            );
          } else if (pendingContentBuffer) {
            const cleaned = ResponseSanitizer.cleanOutput(pendingContentBuffer);
            if (cleaned) {
              flushContent(cleaned);
            }
            pendingContentBuffer = "";
          }

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

          if (options?.includeUsage) {
            const promptTokens = options.promptTokens ?? 0;
            const completionTokens = calculateTokens(fullContent);
            const usageChunk: ChatCompletionChunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`),
            );
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          console.error("Stream read error:", err);
          controller.error(err);
        }
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

  let body: ChatCompletionRequest;
  try {
    const raw = await c.req.json();
    body = chatRequestSchema.parse(raw) as unknown as ChatCompletionRequest;
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

  // Tool calling: inject instructions into messages
  const hasTools = Array.isArray(tools) && tools.length > 0 && tool_choice !== "none";
  let finalMessages = messages;
  if (hasTools && tools) {
    finalMessages = ToolCallingEmulator.injectToolsIntoMessages(
      messages,
      tools as ToolDefinition[],
      tool_choice,
    );
  }

  const prompt = formatMessagesFor1Min(finalMessages);
  c.set("model", cleanModel);
  c.set("promptTokens", calculateTokens(prompt));

  const payload = {
    type: resolvedFeatureType,
    model: cleanModel,
    promptObject: {
      prompt,
      isMixed: false,
      webSearch,
      ...(imageList.length > 0 ? { imageList } : {}),
      ...(body.max_tokens || body.max_completion_tokens
        ? { maxTokens: body.max_tokens ?? body.max_completion_tokens }
        : {}),
    },
  };

  const chatId = newChatId();

  try {
    if (stream) {
      const streamingOptions = {
        allowedTools: tools as ToolDefinition[] | undefined,
        hasTools,
        includeUsage: body.stream_options?.include_usage ?? false,
        promptTokens: calculateTokens(prompt),
      };

      const streamBody = await callChatStream(apiKey, payload);
      const syntheticResponse = new Response(streamBody, {
        headers: { "Content-Type": "text/event-stream" },
      });
      return buildStreamingResponse(
        syntheticResponse,
        cleanModel,
        chatId,
        streamingOptions,
      );
    }

    // Non-streaming
    const data = await callChat(apiKey, payload);
    const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
    let rawContent = "";
    if (typeof resultObj === "string") {
      rawContent = resultObj;
    } else if (
      Array.isArray(resultObj) &&
      typeof resultObj[0] === "string"
    ) {
      rawContent = resultObj[0];
    } else if (resultObj && typeof resultObj === "object") {
      rawContent = JSON.stringify(resultObj);
    }

    // Parse tool calls
    const toolCalls = hasTools
      ? ToolCallingEmulator.parseResponse(rawContent, tools as ToolDefinition[])
      : null;

    const finishReason =
      toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop";

    const cleanContent = toolCalls
      ? null
      : ResponseSanitizer.cleanOutput(rawContent);

    const promptTokens = calculateTokens(prompt);
    const completionTokens = calculateTokens(rawContent);

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
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    return c.json(response);
  } catch (err) {
    console.error("Chat completion error:", err);
    throw err;
  }
});

export default app;
