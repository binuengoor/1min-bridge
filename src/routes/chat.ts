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
  callOpenAiChat,
  callOpenAiChatStream,
  chatText,
  chatTextStream,
  extractLegacyText,
  iterateOpenAiSse,
  shouldFallbackToLegacy,
  supportsNativeTools,
  toNativeOpenAiMessages,
  toPlainOpenAiMessages,
  uploadAsset,
  type OpenAiChatBody,
} from "../adapters/onemin.js";
import { config } from "../config.js";
import { invalidRequestError, modelNotFoundError, sendError } from "../errors.js";
import {
  ToolCallingEmulator,
  type ToolDefinition,
} from "../adapters/tool-emulator.js";
import { parseToolCalls } from "../adapters/tool-parser.js";
import { ResponseSanitizer } from "../adapters/sanitizer.js";
import { calculateTokens } from "../utils/tokens.js";
import type {
  Env,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  ToolCall,
  ChatContentPart,
  OneMinRequestBody,
} from "../types.js";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Feature suffix mapping
// ---------------------------------------------------------------------------

const FEATURE_SUFFIX_MAP: Record<string, string> = {
  ":pdf": "UNIFY_CHAT_WITH_AI",
  ":summarize": "UNIFY_CHAT_WITH_AI",
  ":code": "UNIFY_CHAT_WITH_AI",
  ":online": "UNIFY_CHAT_WITH_AI", // special: triggers webSearch flag
};

function resolveFeatureType(modelName: string): {
  featureType: string;
  cleanModel: string;
  webSearch: boolean;
} {
  for (const suffix of Object.keys(FEATURE_SUFFIX_MAP)) {
    if (modelName.endsWith(suffix)) {
      return {
        // All suffixes now resolve to UNIFY_CHAT_WITH_AI per 1min.ai migration
        // guide (legacy CHAT_WITH_PDF / SUMMARIZER / CODE_GENERATOR are
        // deprecated on /api/chat-with-ai). PDFs/files ride via
        // promptObject.attachments.files; :online toggles webSearchSettings.
        featureType: "UNIFY_CHAT_WITH_AI",
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
  // Upstream 1min.ai passthrough (nested promptObject.settings per Chat with AI API)
  brandVoiceId: z.string().optional(),
  withMemories: z.boolean().optional(),
  numOfSite: z.number().int().min(1).max(10).optional(),
  maxWord: z.number().int().min(100).max(10000).optional(),
  historyMessageLimit: z.number().int().min(1).max(50).optional(),
  conversationId: z.string().optional(),
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
        ? `[System Context - Retrieved Tool Result for ${m.tool_call_id}]:`
        : `[System Context - Retrieved Tool Result]:`;
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
      parts.push(`[Assistant called tool: ${callsStr}]`);
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
          if (!text || ResponseSanitizer.isCrawlingStatus(text)) return;
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

                pendingContentBuffer += content;
                // Flush safe prose prefix immediately; retain only the
                // suffix that may be an incomplete tool-call block.
                const [safeProse, retained] =
                  ToolCallingEmulator.splitSafeProse(pendingContentBuffer);
                if (safeProse) flushContent(safeProse);
                pendingContentBuffer = retained;
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
                pendingContentBuffer += text;
                const [safeProse, retained] =
                  ToolCallingEmulator.splitSafeProse(pendingContentBuffer);
                if (safeProse) flushContent(safeProse);
                pendingContentBuffer = retained;
              }
            }
          }

          // Check for tool calls in full accumulated content (primary +
          // Mistral/Qwen/XML fallback formats)
          const toolCalls = ToolCallingEmulator.parseResponseWithFallback(
            fullContent,
            allowedTools,
            (t) => parseToolCalls(t),
          );
          const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

          if (hasToolCalls && toolCalls) {
            // Emit any residual unflushed prose in pendingContentBuffer
            // (stripped of tool blocks) so trailing prose is not swallowed.
            const proseRemainder = ResponseSanitizer.cleanOutput(
              ResponseSanitizer.stripToolJson(pendingContentBuffer),
            );
            if (proseRemainder) flushContent(proseRemainder);
            pendingContentBuffer = "";

            const deltas =
              ToolCallingEmulator.formatProgressiveToolCallDeltas(toolCalls);
            for (const d of deltas) {
              const toolDeltaChunk: ChatCompletionChunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: d.index,
                          ...(d.id ? { id: d.id } : {}),
                          type: "function",
                          function: { ...d.function },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(toolDeltaChunk)}\n\n`),
              );
            }
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
// OpenAI-upstream helpers (native tool calling + passthrough streaming)
// ---------------------------------------------------------------------------

/** Normalise OpenAI/Anthropic-style tool defs to OpenAI `tools` entries. */
function toNativeTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function?.name || t.name || "unnamed_tool",
      description: t.function?.description || t.description || "",
      parameters: t.function?.parameters ||
        t.parameters ||
        t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function toNativeToolChoice(choice: unknown): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  if (typeof choice === "object" && choice !== null) {
    const c = choice as { type?: string; name?: string; function?: { name?: string } };
    if (c.type === "any") return "required";
    if (c.type === "auto") return "auto";
    if (c.function?.name) return { type: "function", function: { name: c.function.name } };
    if (c.type === "tool" && c.name) return { type: "function", function: { name: c.name } };
  }
  return undefined;
}

/** True when the caller insists on a tool call (retry via ReAct is allowed). */
function forcesToolCall(choice: unknown): boolean {
  if (choice === "required") return true;
  if (typeof choice === "object" && choice !== null) {
    const c = choice as { type?: string; function?: unknown };
    return c.type === "any" || c.type === "tool" || Boolean(c.function);
  }
  return false;
}

function sampling(body: ChatCompletionRequest) {
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  return {
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(body.stop !== undefined ? { stop: body.stop } : {}),
    ...(body.frequency_penalty !== undefined ? { frequency_penalty: body.frequency_penalty } : {}),
    ...(body.presence_penalty !== undefined ? { presence_penalty: body.presence_penalty } : {}),
  };
}

/**
 * Stream a native tool-calling model: forward upstream chat.completion.chunk
 * deltas (id/model rewritten). If a tools request ends with prose that holds a
 * textual tool call, convert it into tool_call deltas.
 */
function buildNativeStreamingResponse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  chatId: string,
  options: {
    allowedTools: ToolDefinition[];
    includeUsage: boolean;
    promptTokens: number;
  },
): Response {
  const created = nowSec();
  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: ChatCompletionChunk,
  ) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let fullContent = "";
        let sawToolCalls = false;
        let finishReason: string | null = null;
        let upstreamUsage:
          | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          | undefined;
        try {
          for await (const chunk of iterateOpenAiSse(upstream)) {
            if (chunk.usage) upstreamUsage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (typeof delta.content === "string") fullContent += delta.content;
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              sawToolCalls = true;
            }
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
              if (!delta.content && !delta.tool_calls) continue; // hold final marker
            }
            send(controller, {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: delta as ChatCompletionChunk["choices"][number]["delta"],
                  finish_reason: null,
                },
              ],
            });
          }

          if (!sawToolCalls && fullContent) {
            const parsed = ToolCallingEmulator.parseResponseWithFallback(
              fullContent,
              options.allowedTools,
              (t) => parseToolCalls(t),
            );
            if (parsed && parsed.length > 0) {
              sawToolCalls = true;
              for (const d of ToolCallingEmulator.formatProgressiveToolCallDeltas(parsed)) {
                send(controller, {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: d.index,
                            ...(d.id ? { id: d.id } : {}),
                            type: "function",
                            function: { ...d.function },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
              }
            }
          }

          send(controller, {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: sawToolCalls ? "tool_calls" : (finishReason ?? "stop"),
              },
            ],
          });

          if (options.includeUsage) {
            const completionTokens =
              upstreamUsage?.completion_tokens ?? calculateTokens(fullContent);
            const promptTokens = upstreamUsage?.prompt_tokens ?? options.promptTokens;
            send(controller, {
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
            });
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          console.error("Native stream error:", err);
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

  // Resolve model suffix (e.g. gpt-4o:pdf, gpt-4o:online) — all map to UNIFY
  const { cleanModel, webSearch } = resolveFeatureType(body.model);

  // Validate model exists and is a chat model
  const modelData = await getModelData();
  if (!modelData.chatModelIds.includes(cleanModel)) {
    return sendError(c, modelNotFoundError(body.model));
  }

  // Handle vision — attachments.images on UNIFY_CHAT_WITH_AI (per migration guide)
  const isVision = hasImageContent(messages);
  let imageList: string[] = [];
  const resolvedFeatureType = "UNIFY_CHAT_WITH_AI";

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

  const extra = body as unknown as Record<string, unknown>;
  const numOfSite =
    typeof extra.numOfSite === "number" ? extra.numOfSite : undefined;
  const maxWord =
    typeof extra.maxWord === "number" ? extra.maxWord : undefined;
  const historyMessageLimit =
    typeof extra.historyMessageLimit === "number"
      ? extra.historyMessageLimit
      : undefined;
  const withMemories =
    typeof extra.withMemories === "boolean" ? extra.withMemories : undefined;
  const brandVoiceId =
    typeof extra.brandVoiceId === "string" ? extra.brandVoiceId : undefined;
  const conversationId =
    typeof extra.conversationId === "string" ? extra.conversationId : undefined;

  const payload: OneMinRequestBody = {
    type: resolvedFeatureType,
    model: cleanModel,
    ...(brandVoiceId ? { brandVoiceId } : {}),
    promptObject: {
      prompt,
      ...(conversationId ? { conversationId } : {}),
      settings: {
        webSearchSettings: {
          webSearch,
          ...(numOfSite !== undefined ? { numOfSite } : {}),
          ...(maxWord !== undefined ? { maxWord } : {}),
        },
        historySettings: {
          isMixed: false,
          ...(historyMessageLimit !== undefined ? { historyMessageLimit } : {}),
        },
        ...(withMemories !== undefined ? { withMemories } : {}),
      },
      ...(imageList.length > 0 ? { attachments: { images: imageList } } : {}),
      ...(body.max_tokens || body.max_completion_tokens
        ? { maxTokens: body.max_tokens ?? body.max_completion_tokens }
        : {}),
    },
  };

  const chatId = newChatId();

  // Route selection. The OpenAI-compatible upstream is primary; features that
  // only exist on the legacy endpoint (web search, vision attachments,
  // brand voice, memories, conversation ids) stay on /api/chat-with-ai.
  const legacyOnly =
    webSearch ||
    isVision ||
    [brandVoiceId, conversationId, numOfSite, maxWord, historyMessageLimit, withMemories].some(
      (v) => v !== undefined,
    );
  const useOpenAi = config.oneMinOpenAiEnabled && !legacyOnly;
  const nativeMode = useOpenAi && hasTools && supportsNativeTools(cleanModel);
  const sampled = sampling(body);
  const emulatedBody: OpenAiChatBody = {
    model: cleanModel,
    messages: toPlainOpenAiMessages(finalMessages),
    ...sampled,
  };
  const nativeBody: OpenAiChatBody = {
    model: cleanModel,
    messages: toNativeOpenAiMessages(messages),
    ...(tools && hasTools ? { tools: toNativeTools(tools as ToolDefinition[]) } : {}),
    ...(toNativeToolChoice(tool_choice) !== undefined
      ? { tool_choice: toNativeToolChoice(tool_choice) }
      : {}),
    ...sampled,
  };

  try {
    if (stream) {
      const streamingOptions = {
        allowedTools: tools as ToolDefinition[] | undefined,
        hasTools,
        includeUsage: body.stream_options?.include_usage ?? false,
        promptTokens: calculateTokens(prompt),
      };

      if (nativeMode) {
        try {
          const raw = await callOpenAiChatStream(apiKey, nativeBody);
          return buildNativeStreamingResponse(raw, cleanModel, chatId, {
            allowedTools: tools as ToolDefinition[],
            includeUsage: streamingOptions.includeUsage,
            promptTokens: streamingOptions.promptTokens,
          });
        } catch (err) {
          if (!shouldFallbackToLegacy(err)) throw err;
          console.warn("Native tool stream failed, using ReAct emulation:", (err as Error).message);
        }
      }

      const streamBody = useOpenAi
        ? await chatTextStream(apiKey, emulatedBody, payload)
        : await callChatStream(apiKey, payload);
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
    let rawContent = "";
    let nativeToolCalls: ToolCall[] | null = null;
    let nativeHandled = false;

    if (nativeMode) {
      try {
        const res = await callOpenAiChat(apiKey, nativeBody);
        const msg = res.choices?.[0]?.message;
        if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
          nativeToolCalls = msg.tool_calls.map((tc, i) => ({
            id: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}_${i}`,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments:
                typeof tc.function.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments ?? {}),
            },
          }));
          nativeHandled = true;
        } else if (typeof msg?.content === "string") {
          rawContent = msg.content;
          nativeHandled = true;
          // Prose that holds a textual tool call is still honoured below; a
          // forced tool_choice that yielded prose is retried through ReAct.
          const textual = ToolCallingEmulator.parseResponseWithFallback(
            rawContent,
            tools as ToolDefinition[],
            (t) => parseToolCalls(t),
          );
          if (!textual && forcesToolCall(tool_choice)) nativeHandled = false;
        }
      } catch (err) {
        if (!shouldFallbackToLegacy(err)) throw err;
        console.warn("Native tool call failed, using ReAct emulation:", (err as Error).message);
      }
    }

    if (!nativeHandled) {
      rawContent = useOpenAi
        ? await chatText(apiKey, emulatedBody, payload)
        : extractLegacyText(await callChat(apiKey, payload));
    }

    // Parse tool calls (primary + Mistral/Qwen/XML fallback)
    const toolCalls =
      nativeToolCalls ??
      ToolCallingEmulator.parseResponseWithFallback(
        rawContent,
        tools as ToolDefinition[],
        (t) => parseToolCalls(t),
      );

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
