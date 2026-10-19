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
  callOpenAiChat,
  callOpenAiChatStream,
  chatTextFull,
  chatTextStream,
  iterateOpenAiSse,
  recordUsageMetrics,
  routeViaOpenAi,
  shouldFallbackToLegacy,
  forcesToolCall,
  toNativeOpenAiMessages,
  toNativeToolChoice,
  toNativeTools,
  toPlainOpenAiMessages,
  uploadAsset,
  type OpenAiChatBody,
  type OpenAiUsage,
} from "../adapters/onemin.js";
import {
  cacheGetOrCompute,
  cacheGet,
  cacheKey,
  cacheSet,
  resolveCacheMode,
  type CachedChat,
} from "../cache/response-cache.js";
import { keyId } from "../upstream/core.js";
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
    onComplete?: (result: CachedChat) => void;
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

          if (options?.onComplete) {
            const promptTokens = options.promptTokens ?? 0;
            const completionTokens = calculateTokens(fullContent);
            options.onComplete({
              content: hasToolCalls ? null : ResponseSanitizer.cleanOutput(fullContent),
              toolCalls: hasToolCalls ? toolCalls : null,
              finishReason: hasToolCalls ? "tool_calls" : "stop",
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            });
          }

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

/** Strip <think>…</think> spans from a streamed delta (stateful across chunks). */
function filterThink(state: { inThink: boolean }, text: string): string {
  let out = "";
  let rest = text;
  while (rest) {
    if (state.inThink) {
      const i = rest.indexOf("</think>");
      if (i < 0) return out;
      state.inThink = false;
      rest = rest.slice(i + 8);
    } else {
      const i = rest.indexOf("<think>");
      if (i < 0) {
        out += rest;
        break;
      }
      out += rest.slice(0, i);
      state.inThink = true;
      rest = rest.slice(i + 7);
    }
  }
  return out;
}

type ChunkChoice = ChatCompletionChunk["choices"][number];

function sseChunk(
  chatId: string,
  created: number,
  model: string,
  delta: ChunkChoice["delta"],
  finishReason: string | null,
): Uint8Array {
  const chunk: ChatCompletionChunk = {
    id: chatId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function usageChunk(
  chatId: string,
  created: number,
  model: string,
  usage: NonNullable<CachedChat["usage"]>,
): Uint8Array {
  const chunk: ChatCompletionChunk = {
    id: chatId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage,
  };
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

/** Return a copy of a Response with extra headers (survives Hono middleware). */
function withHeaders(r: Response, extra: Record<string, string>): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/**
 * Stream from the OpenAI upstream: forward chat.completion.chunk deltas with
 * id/model rewritten, strip <think> spans, accumulate the result for caching,
 * and convert a textual tool call into tool_call deltas if the model emitted
 * one as prose.
 */
function buildNativeStreamingResponse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  chatId: string,
  options: {
    allowedTools?: ToolDefinition[];
    includeUsage: boolean;
    fallbackPromptTokens: number;
    onComplete?: (result: CachedChat) => void;
  },
): Response {
  const created = nowSec();
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let fullContent = "";
        const think = { inThink: false };
        const acc = new Map<number, { id: string; name: string; args: string }>();
        let finishReason: string | null = null;
        let usage: OpenAiUsage | undefined;
        try {
          for await (const chunk of iterateOpenAiSse(upstream)) {
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = { ...(choice.delta ?? {}) };
            if (typeof delta.content === "string") {
              const visible = filterThink(think, delta.content);
              fullContent += visible;
              if (visible) delta.content = visible;
              else delete delta.content;
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (tc.id === null) delete tc.id; // some providers send "id": null
                const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name += tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                acc.set(tc.index, cur);
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
            if (Object.keys(delta).length === 0) continue;
            controller.enqueue(
              sseChunk(chatId, created, model, delta as ChunkChoice["delta"], null),
            );
          }

          let toolCalls: ToolCall[] | null =
            acc.size > 0
              ? [...acc.entries()]
                  .sort((x, y) => x[0] - y[0])
                  .map(([, v], i) => ({
                    id: v.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}_${i}`,
                    type: "function" as const,
                    function: { name: v.name, arguments: v.args || "{}" },
                  }))
              : null;

          if (!toolCalls && fullContent && options.allowedTools?.length) {
            const parsed = ToolCallingEmulator.parseResponseWithFallback(
              fullContent,
              options.allowedTools,
              (t) => parseToolCalls(t),
            );
            if (parsed && parsed.length > 0) {
              toolCalls = parsed;
              for (const d of ToolCallingEmulator.formatProgressiveToolCallDeltas(parsed)) {
                controller.enqueue(
                  sseChunk(
                    chatId,
                    created,
                    model,
                    {
                      tool_calls: [
                        {
                          index: d.index,
                          ...(d.id ? { id: d.id } : {}),
                          type: "function",
                          function: { ...d.function },
                        },
                      ],
                    },
                    null,
                  ),
                );
              }
            }
          }

          const finish = toolCalls ? "tool_calls" : (finishReason ?? "stop");
          controller.enqueue(sseChunk(chatId, created, model, {}, finish));

          const promptTokens = usage?.prompt_tokens ?? options.fallbackPromptTokens;
          const completionTokens = usage?.completion_tokens ?? calculateTokens(fullContent);
          const finalUsage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          };
          recordUsageMetrics(model, usage);
          if (options.includeUsage) {
            controller.enqueue(usageChunk(chatId, created, model, finalUsage));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          options.onComplete?.({
            content: toolCalls ? null : fullContent,
            toolCalls,
            finishReason: finish,
            usage: finalUsage,
          });
        } catch (err) {
          console.error("Native stream error:", err);
          controller.error(err);
        }
      },
    }),
    { headers: { ...SSE_HEADERS, "X-Request-Id": chatId } },
  );
}

/** Replay a cached result as an SSE stream. */
function replayCachedStream(
  result: CachedChat,
  model: string,
  chatId: string,
  includeUsage: boolean,
): Response {
  const created = nowSec();
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseChunk(chatId, created, model, { role: "assistant" }, null));
        if (result.content) {
          controller.enqueue(sseChunk(chatId, created, model, { content: result.content }, null));
        }
        if (result.toolCalls) {
          for (const d of ToolCallingEmulator.formatProgressiveToolCallDeltas(result.toolCalls)) {
            controller.enqueue(
              sseChunk(
                chatId,
                created,
                model,
                {
                  tool_calls: [
                    {
                      index: d.index,
                      ...(d.id ? { id: d.id } : {}),
                      type: "function",
                      function: { ...d.function },
                    },
                  ],
                },
                null,
              ),
            );
          }
        }
        controller.enqueue(sseChunk(chatId, created, model, {}, result.finishReason));
        if (includeUsage && result.usage) {
          controller.enqueue(usageChunk(chatId, created, model, result.usage));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { ...SSE_HEADERS, "X-Request-Id": chatId } },
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

  // Route selection. The OpenAI-compatible upstream is primary (native tools on
  // every model it serves). Features that only exist on the legacy endpoint
  // (web search, vision attachments, brand voice, memories, conversation ids)
  // and models the endpoint does not serve use /api/chat-with-ai.
  const legacyOnly =
    webSearch ||
    isVision ||
    [brandVoiceId, conversationId, numOfSite, maxWord, historyMessageLimit, withMemories].some(
      (v) => v !== undefined,
    );
  const viaOpenAi = !legacyOnly && (await routeViaOpenAi(apiKey, cleanModel));
  c.set("model", cleanModel);
  c.header("X-Bridge-Route", viaOpenAi ? "openai" : "legacy");

  const hasTools = Array.isArray(tools) && tools.length > 0 && tool_choice !== "none";
  const sampled = sampling(body);
  const structured =
    body.response_format?.type === "json_schema"
      ? { response_format: body.response_format as Record<string, unknown> }
      : {};

  // Legacy / ReAct material is built lazily: the native path never pays for it.
  let legacyCache: { prompt: string; payload: OneMinRequestBody; emulated: OpenAiChatBody } | null = null;
  const legacy = () => {
    if (legacyCache) return legacyCache;
    const finalMessages = hasTools
      ? ToolCallingEmulator.injectToolsIntoMessages(messages, tools as ToolDefinition[], tool_choice)
      : messages;
    const prompt = formatMessagesFor1Min(finalMessages);
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
    legacyCache = {
      prompt,
      payload,
      emulated: { model: cleanModel, messages: toPlainOpenAiMessages(finalMessages), ...sampled },
    };
    return legacyCache;
  };

  // json_object is rejected upstream: enforce it with a stable leading system
  // instruction (keeps the cacheable prefix constant) and strip fences below.
  const jsonMode = body.response_format?.type === "json_object";
  const nativeMessages = toNativeOpenAiMessages(messages);
  if (jsonMode) {
    nativeMessages.unshift({
      role: "system",
      content:
        "Respond with a single valid JSON object only. No prose, no markdown code fences.",
    });
  }
  const nativeBody: OpenAiChatBody = {
    model: cleanModel,
    messages: nativeMessages,
    ...(tools && hasTools ? { tools: toNativeTools(tools as ToolDefinition[]) } : {}),
    ...(hasTools && toNativeToolChoice(tool_choice) !== undefined
      ? { tool_choice: toNativeToolChoice(tool_choice) }
      : {}),
    ...sampled,
    ...structured,
  };

  const chatId = newChatId();
  const includeUsage = body.stream_options?.include_usage ?? false;

  // Response cache (deterministic requests only; see resolveCacheMode)
  const cacheable = !legacyOnly && resolveCacheMode(c.req.raw.headers, body.temperature);
  const key = cacheable
    ? cacheKey({
        k: keyId(apiKey),
        model: cleanModel,
        messages,
        tools: hasTools ? tools : null,
        tool_choice: hasTools ? tool_choice : null,
        sampled,
        structured,
      })
    : null;

  const finish = (result: CachedChat, status: string): Response => {
    const promptTokens = result.usage?.prompt_tokens ?? 0;
    const completionTokens = result.usage?.completion_tokens ?? 0;
    c.set("promptTokens", promptTokens);
    c.set("completionTokens", completionTokens);
    if (status === "HIT" || status === "COALESCED") c.set("credits", 0);
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
            content: result.content,
            ...(result.toolCalls && result.toolCalls.length > 0
              ? { tool_calls: result.toolCalls }
              : {}),
          },
          finish_reason: result.finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: result.usage?.total_tokens ?? promptTokens + completionTokens,
      },
    };
    return c.json(response, 200, key ? { "X-Bridge-Cache": status } : {});
  };

  try {
    if (stream) {
      if (key) {
        const hit = cacheGet(key);
        if (hit) {
          c.set("promptTokens", 0);
          c.set("completionTokens", 0);
          c.set("credits", 0);
          return withHeaders(replayCachedStream(hit, cleanModel, chatId, includeUsage), {
            "X-Bridge-Cache": "HIT",
            "X-Bridge-Route": "cache",
          });
        }
      }
      const onComplete = key ? (r: CachedChat) => cacheSet(key, r) : undefined;
      const approxPrompt = Math.ceil(JSON.stringify(messages).length / 4);
      c.set("promptTokens", approxPrompt);

      let nativeFailed = false;
      if (viaOpenAi) {
        try {
          const raw = await callOpenAiChatStream(apiKey, nativeBody);
          const r = buildNativeStreamingResponse(raw, cleanModel, chatId, {
            allowedTools: hasTools ? (tools as ToolDefinition[]) : undefined,
            includeUsage,
            fallbackPromptTokens: approxPrompt,
            onComplete,
          });
          return withHeaders(r, {
            "X-Bridge-Route": "openai",
            ...(key ? { "X-Bridge-Cache": "MISS" } : {}),
          });
        } catch (err) {
          if (!shouldFallbackToLegacy(err)) throw err;
          nativeFailed = true;
          console.warn("Native stream failed, falling back:", (err as Error).message);
        }
      }

      const lg = legacy();
      c.set("promptTokens", calculateTokens(lg.prompt));
      const streamBody = await chatTextStream(
        apiKey,
        lg.emulated,
        lg.payload,
        !viaOpenAi || nativeFailed,
      );
      const r = buildStreamingResponse(
        new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } }),
        cleanModel,
        chatId,
        {
          allowedTools: tools as ToolDefinition[] | undefined,
          hasTools,
          includeUsage,
          promptTokens: calculateTokens(lg.prompt),
          onComplete,
        },
      );
      return withHeaders(r, {
        "X-Bridge-Route": "legacy",
        ...(key ? { "X-Bridge-Cache": "MISS" } : {}),
      });
    }

    // Non-streaming
    const generate = async (): Promise<CachedChat> => {
      let nativeFailed = false;
      if (viaOpenAi) {
        try {
          const res = await callOpenAiChat(apiKey, nativeBody);
          const choice = res.choices?.[0];
          const msg = choice?.message;
          const usage = res.usage
            ? {
                prompt_tokens: res.usage.prompt_tokens ?? 0,
                completion_tokens: res.usage.completion_tokens ?? 0,
                total_tokens:
                  res.usage.total_tokens ??
                  (res.usage.prompt_tokens ?? 0) + (res.usage.completion_tokens ?? 0),
              }
            : undefined;
          if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
            return {
              content: null,
              toolCalls: msg.tool_calls.map((tc, i) => ({
                id: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}_${i}`,
                type: "function" as const,
                function: {
                  name: tc.function.name,
                  arguments:
                    typeof tc.function.arguments === "string"
                      ? tc.function.arguments
                      : JSON.stringify(tc.function.arguments ?? {}),
                },
              })),
              finishReason: "tool_calls",
              usage,
            };
          }
          if (typeof msg?.content === "string") {
            const text = msg.content;
            // Prose that holds a textual tool call is still honoured.
            const textual = hasTools
              ? ToolCallingEmulator.parseResponseWithFallback(
                  text,
                  tools as ToolDefinition[],
                  (t) => parseToolCalls(t),
                )
              : null;
            if (textual && textual.length > 0) {
              return { content: null, toolCalls: textual, finishReason: "tool_calls", usage };
            }
            // A forced tool_choice that produced prose is retried via ReAct.
            if (!(hasTools && forcesToolCall(tool_choice))) {
              const visible = ResponseSanitizer.stripReasoning(text);
              const fenced = jsonMode ? /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(visible.trim()) : null;
              return {
                content: fenced ? fenced[1]! : visible,
                toolCalls: null,
                finishReason: choice?.finish_reason ?? "stop",
                usage,
              };
            }
          }
        } catch (err) {
          if (!shouldFallbackToLegacy(err)) throw err;
          nativeFailed = true;
          console.warn("Native call failed, falling back:", (err as Error).message);
        }
      }

      const lg = legacy();
      const { text, usage: u } = await chatTextFull(
        apiKey,
        lg.emulated,
        lg.payload,
        !viaOpenAi || nativeFailed,
      );
      const toolCalls = ToolCallingEmulator.parseResponseWithFallback(
        text,
        tools as ToolDefinition[],
        (t) => parseToolCalls(t),
      );
      const hasCalls = Boolean(toolCalls && toolCalls.length > 0);
      const promptTokens = u?.prompt_tokens ?? calculateTokens(lg.prompt);
      const completionTokens = u?.completion_tokens ?? calculateTokens(text);
      return {
        content: hasCalls ? null : ResponseSanitizer.cleanOutput(text),
        toolCalls: hasCalls ? toolCalls : null,
        finishReason: hasCalls ? "tool_calls" : "stop",
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    };

    if (key) {
      const { value, status } = await cacheGetOrCompute(key, generate);
      return finish(value, status);
    }
    return finish(await generate(), "BYPASS");
  } catch (err) {
    console.error("Chat completion error:", err);
    throw err;
  }
});

export default app;
