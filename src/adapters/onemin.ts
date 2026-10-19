// ============================================================================
// 1min-bridge — 1min.ai API Adapter
// Supports: UNIFY_CHAT_WITH_AI (Chat API) and AI Feature API
// ============================================================================

import { config } from "../config.js";
import type {
  OneMinRequestBody,
  OneMinResponse,
  OneMinAssetResponse,
  ChatMessage,
  ToolCall,
} from "../types.js";
import { upstreamError, RelayError } from "../errors.js";
import {
  openAiFetch,
  withIdleTimeout,
  getEndpointModels,
  breakerOpen,
  recordUpstreamSuccess,
  recordUpstreamFailure,
  markModelUnsupported,
} from "../upstream/core.js";
import { incrementCounter } from "../metrics.js";
import type { ToolDefinition } from "./tool-emulator.js";
import { ResponseSanitizer } from "./sanitizer.js";

const FETCH_TIMEOUT_MS = 120_000; // 2 min for generation requests
const UPLOAD_TIMEOUT_MS = 30_000; // 30s for asset uploads

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "API-KEY": apiKey,
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible upstream (POST /openai/v1/chat/completions)
// ---------------------------------------------------------------------------

export interface OpenAiUpstreamMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiChatBody {
  model: string;
  messages: OpenAiUpstreamMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  response_format?: Record<string, unknown>;
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface OpenAiChatCompletion {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAiUsage;
}

export interface OpenAiChatChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAiUsage;
  error?: { message?: string };
}

/**
 * Should this model be served by the OpenAI-compatible upstream? True when the
 * endpoint is enabled, the model is on the endpoint's (cached) model list, and
 * its circuit breaker is closed. Every model on that list was verified to
 * execute native tool calls; anything else goes to the legacy endpoint.
 */
export async function routeViaOpenAi(apiKey: string, model: string): Promise<boolean> {
  if (!config.oneMinOpenAiEnabled) return false;
  if (breakerOpen(model)) return false;
  const models = await getEndpointModels(apiKey);
  return models === null || models.has(model); // unknown list => optimistic
}

/** Update breaker state and metrics after an OpenAI-upstream attempt. */
export function noteOpenAiOutcome(model: string, err?: unknown): void {
  if (!err) {
    recordUpstreamSuccess(model);
    incrementCounter("1min_bridge_upstream_requests_total", { route: "openai", result: "ok" });
    return;
  }
  const status = err instanceof RelayError ? err.status : 0;
  if (err instanceof RelayError && err.code === "model_not_found") {
    markModelUnsupported(model);
  } else if (status === 0 || status >= 500 || status === 429) {
    recordUpstreamFailure(model);
  }
  incrementCounter("1min_bridge_upstream_requests_total", {
    route: "openai",
    result: `error_${status || "network"}`,
  });
}

/** Count prompt/cached tokens so cache effectiveness is visible in /metrics. */
export function recordUsageMetrics(model: string, usage?: OpenAiUsage): void {
  if (!usage) return;
  incrementCounter("1min_bridge_prompt_tokens_total", { model }, usage.prompt_tokens ?? 0);
  incrementCounter(
    "1min_bridge_cached_prompt_tokens_total",
    { model },
    usage.prompt_tokens_details?.cached_tokens ?? 0,
  );
}

/**
 * Flatten bridge messages into plain role/content messages that any upstream
 * model accepts: developer -> system, tool results and assistant tool calls ->
 * prose (the ReAct emulator reads them back in this form).
 */
export function toPlainOpenAiMessages(
  messages: ChatMessage[],
): OpenAiUpstreamMessage[] {
  const out: OpenAiUpstreamMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool" || m.role === "function") {
      const clean = ResponseSanitizer.unpackMemoryContent(m.content);
      const prefix = m.tool_call_id
        ? `[System Context - Retrieved Tool Result for ${m.tool_call_id}]:`
        : `[System Context - Retrieved Tool Result]:`;
      out.push({ role: "user", content: `${prefix}\n${clean}` });
      continue;
    }
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const calls = m.tool_calls
        .map((tc) => {
          const args = tc.function?.arguments ?? "{}";
          return `${tc.function?.name || "unnamed_tool"}(${
            typeof args === "string" ? args : JSON.stringify(args)
          })`;
        })
        .join(", ");
      out.push({ role: "assistant", content: `[Assistant called tool: ${calls}]` });
      continue;
    }
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p) => p && typeof p === "object" && p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
    } else if (m.content) {
      text = ResponseSanitizer.unpackMemoryContent(m.content);
    }
    if (!text) continue;
    out.push({
      role:
        m.role === "system" || m.role === "developer"
          ? "system"
          : m.role === "assistant"
            ? "assistant"
            : "user",
      content: text,
    });
  }
  return out;
}

/**
 * Messages for native tool calling: keep tool / tool_calls structure intact
 * (text parts only; vision is routed to the legacy endpoint).
 */
export function toNativeOpenAiMessages(
  messages: ChatMessage[],
): OpenAiUpstreamMessage[] {
  const mapped = messages.map((m) => {
    const role =
      m.role === "developer"
        ? "system"
        : m.role === "function"
          ? "tool"
          : m.role;
    let content: string | null;
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content))
      content = m.content
        .filter((p) => p && typeof p === "object" && p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
    else content = m.content ? ResponseSanitizer.unpackMemoryContent(m.content) : null;

    const msg: OpenAiUpstreamMessage = { role: role as OpenAiUpstreamMessage["role"], content };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      msg.tool_calls = m.tool_calls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: "function",
        function: {
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
        },
      }));
    }
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.name && role !== "tool") msg.name = m.name;
    return msg;
  });

  // Parallel tool calls arrive as several assistant messages; the OpenAI
  // schema wants them merged into one assistant message before the results.
  const out: OpenAiUpstreamMessage[] = [];
  for (const msg of mapped) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === "assistant" &&
      msg.role === "assistant" &&
      prev.tool_calls?.length &&
      msg.tool_calls?.length &&
      !msg.content
    ) {
      prev.tool_calls.push(...msg.tool_calls);
      continue;
    }
    out.push(msg);
  }
  return out;
}

/** Normalise OpenAI/Anthropic-style tool defs to OpenAI `tools` entries. */
export function toNativeTools(tools: ToolDefinition[]): unknown[] {
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

export function toNativeToolChoice(choice: unknown): unknown {
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
export function forcesToolCall(choice: unknown): boolean {
  if (choice === "required") return true;
  if (typeof choice === "object" && choice !== null) {
    const c = choice as { type?: string; function?: unknown };
    return c.type === "any" || c.type === "tool" || Boolean(c.function);
  }
  return false;
}

/** Non-streaming OpenAI chat call (POST /openai/v1/chat/completions) */
export async function callOpenAiChat(
  apiKey: string,
  body: OpenAiChatBody,
): Promise<OpenAiChatCompletion> {
  try {
    const res = await openAiFetch(
      apiKey,
      { ...body, stream: false },
      { stream: false, totalTimeoutMs: FETCH_TIMEOUT_MS },
    );
    const data = (await res.json()) as OpenAiChatCompletion;
    noteOpenAiOutcome(body.model);
    recordUsageMetrics(body.model, data.usage);
    return data;
  } catch (err) {
    noteOpenAiOutcome(body.model, err);
    throw err;
  }
}

/** Streaming OpenAI chat call; returns the raw upstream SSE byte stream. */
export async function callOpenAiChatStream(
  apiKey: string,
  body: OpenAiChatBody,
): Promise<ReadableStream<Uint8Array>> {
  try {
    const res = await openAiFetch(
      apiKey,
      { ...body, stream: true, stream_options: { include_usage: true } },
      { stream: true },
    );
    if (!res.body) throw upstreamError(500, "No response body from OpenAI chat stream");
    noteOpenAiOutcome(body.model);
    return withIdleTimeout(res.body);
  } catch (err) {
    noteOpenAiOutcome(body.model, err);
    throw err;
  }
}

/** Parse an OpenAI SSE byte stream into chat.completion.chunk objects. */
export async function* iterateOpenAiSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAiChatChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseLine = (line: string): OpenAiChatChunk | null => {
    const t = line.trim();
    if (!t.startsWith("data:")) return null;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") return null;
    try {
      return JSON.parse(data) as OpenAiChatChunk;
    } catch {
      return null;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const chunk = parseLine(line);
        if (chunk) {
          if (chunk.error) {
            throw upstreamError(502, chunk.error.message ?? "stream error");
          }
          yield chunk;
        }
      }
    }
    const last = parseLine(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Adapt an OpenAI SSE stream to the bridge's internal text stream
 * (`data: "<text>"` lines) so the ReAct/sanitizer pipelines work unchanged.
 */
export function openAiStreamToTextStream(
  raw: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of iterateOpenAiSse(raw)) {
          const text = chunk.choices?.[0]?.delta?.content;
          if (typeof text === "string" && text && !ResponseSanitizer.isCrawlingStatus(text)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(text)}\n\n`));
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        console.error("OpenAI chat streaming error:", err);
        controller.error(err);
      }
    },
  });
}

/** Whether a failed OpenAI-upstream call should retry on the legacy endpoint. */
export function shouldFallbackToLegacy(err: unknown): boolean {
  if (!config.oneMinOpenAiEnabled) return false;
  if (err instanceof RelayError) {
    return ![401, 403, 429].includes(err.status);
  }
  return true; // network error / timeout
}

/** Extract assistant text from a legacy /api/chat-with-ai response. */
export function extractLegacyText(data: OneMinResponse): string {
  const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
  if (typeof resultObj === "string") return resultObj;
  if (Array.isArray(resultObj) && typeof resultObj[0] === "string") return resultObj[0];
  if (resultObj && typeof resultObj === "object") return JSON.stringify(resultObj);
  return "";
}

/**
 * Text completion via the OpenAI upstream, falling back to the legacy
 * endpoint when the model is not served there or the provider rejects it.
 */
export async function chatTextFull(
  apiKey: string,
  body: OpenAiChatBody,
  legacy: OneMinRequestBody,
  legacyOnly = false,
): Promise<{ text: string; usage?: OpenAiUsage }> {
  if (!legacyOnly && (await routeViaOpenAi(apiKey, body.model))) {
    try {
      const res = await callOpenAiChat(apiKey, body);
      const text = res.choices?.[0]?.message?.content;
      if (typeof text === "string") return { text, usage: res.usage };
    } catch (err) {
      if (!shouldFallbackToLegacy(err)) throw err;
      console.warn("OpenAI upstream failed, falling back to legacy:", (err as Error).message);
    }
  }
  incrementCounter("1min_bridge_upstream_requests_total", { route: "legacy", result: "ok" });
  return { text: extractLegacyText(await callChat(apiKey, legacy)) };
}

export async function chatText(
  apiKey: string,
  body: OpenAiChatBody,
  legacy: OneMinRequestBody,
  legacyOnly = false,
): Promise<string> {
  return (await chatTextFull(apiKey, body, legacy, legacyOnly)).text;
}

/** Streaming counterpart of chatText; yields the internal text stream. */
export async function chatTextStream(
  apiKey: string,
  body: OpenAiChatBody,
  legacy: OneMinRequestBody,
  legacyOnly = false,
): Promise<ReadableStream<Uint8Array>> {
  if (!legacyOnly && (await routeViaOpenAi(apiKey, body.model))) {
    try {
      return openAiStreamToTextStream(await callOpenAiChatStream(apiKey, body));
    } catch (err) {
      if (!shouldFallbackToLegacy(err)) throw err;
      console.warn("OpenAI upstream stream failed, falling back to legacy:", (err as Error).message);
    }
  }
  incrementCounter("1min_bridge_upstream_requests_total", { route: "legacy", result: "ok" });
  return callChatStream(apiKey, legacy);
}

/** Non-streaming Chat API call (POST /api/chat-with-ai) */
export async function callChat(
  apiKey: string,
  body: OneMinRequestBody,
): Promise<OneMinResponse> {
  const structuredBody = {
    ...body,
    type: body.type && body.type !== "CHAT_WITH_AI" ? body.type : "UNIFY_CHAT_WITH_AI",
  };

  const res = await fetch(config.oneMinChatApiUrl, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(structuredBody),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw upstreamError(res.status, text);
  }

  return (await res.json()) as OneMinResponse;
}

/** Streaming Chat API call (POST /api/chat-with-ai?isStreaming=true) */
export async function callChatStream(
  apiKey: string,
  body: OneMinRequestBody,
): Promise<ReadableStream<Uint8Array>> {
  const structuredBody = {
    ...body,
    type: body.type && body.type !== "CHAT_WITH_AI" ? body.type : "UNIFY_CHAT_WITH_AI",
  };

  const res = await fetch(config.oneMinChatStreamingUrl, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(structuredBody),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw upstreamError(res.status, text);
  }

  if (!res.body) {
    throw upstreamError(500, "No response body from Chat API stream");
  }

  const upstream = res.body;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let currentEvent = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.slice(6).trim();
              continue;
            }

            if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trim();
              if (data === "[DONE]") continue;

              // Filter out metadata and reasoning event chunks from main text stream
              if (currentEvent === "ai_record_result" || currentEvent === "llm_result" || currentEvent === "reasoning") {
                currentEvent = "";
                continue;
              }

              let textChunk: string | null = null;
              try {
                const parsed = JSON.parse(data);
                if (typeof parsed === "string") {
                  textChunk = parsed;
                } else if (parsed && typeof parsed === "object") {
                  if (typeof (parsed as any).content === "string") {
                    textChunk = (parsed as any).content;
                  } else if (typeof (parsed as any).text === "string") {
                    textChunk = (parsed as any).text;
                  }
                }
              } catch {
                textChunk = data;
              }

              if (textChunk) {
                // Drop ephemeral 1min.ai search / crawling status banners
                if (ResponseSanitizer.isCrawlingStatus(textChunk)) {
                  currentEvent = "";
                  continue;
                }

                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(textChunk)}\n\n`),
                );
              }

              currentEvent = "";
            }
          }
        }

        // Flush trailing buffer
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(buffer.trim())}\n\n`));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        console.error("Chat streaming error:", err);
        controller.error(err);
      }
    },
  });
}

/** Non-streaming feature call (POST /api/features) */
export async function callFeature(
  apiKey: string,
  body: OneMinRequestBody,
): Promise<OneMinResponse> {
  const res = await fetch(config.oneMinApiUrl, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw upstreamError(res.status, text);
  }

  return (await res.json()) as OneMinResponse;
}

/** Streaming feature call (POST /api/features?isStreaming=true) */
export async function callFeatureStream(
  apiKey: string,
  body: OneMinRequestBody,
): Promise<Response> {
  const res = await fetch(config.oneMinStreamingUrl, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw upstreamError(res.status, text);
  }

  return res;
}

export async function callFeatureStreamStructured(
  apiKey: string,
  body: OneMinRequestBody,
): Promise<ReadableStream<Uint8Array>> {
  return callChatStream(apiKey, body);
}

/** Upload image to 1min.ai assets, returns URL */
export async function uploadAsset(
  apiKey: string,
  imageData: string | ArrayBuffer,
  mimeType: string,
): Promise<string> {
  if (typeof imageData === "string") {
    if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
      return imageData;
    }
    if (imageData.startsWith("data:")) {
      const base64Part = imageData.split(",")[1] ?? imageData;
      const buf = Buffer.from(base64Part, "base64");
      return uploadBlob(
        apiKey,
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        mimeType,
      );
    }
  }

  const uint8 = new Uint8Array(imageData as ArrayBuffer);
  return uploadBlob(apiKey, uint8, mimeType);
}

async function uploadBlob(
  apiKey: string,
  data: Uint8Array,
  mimeType: string,
): Promise<string> {
  const formData = new FormData();
  const ext = mimeType.split("/")[1] || "png";
  formData.append(
    "file",
    new Blob(
      [
        new Uint8Array(
          data.buffer as ArrayBuffer,
          data.byteOffset,
          data.byteLength,
        ),
      ],
      { type: mimeType },
    ),
    `image.${ext}`,
  );

  const res = await fetch(config.oneMinAssetUrl, {
    method: "POST",
    headers: { "API-KEY": apiKey },
    body: formData,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw upstreamError(
      res.status,
      `Asset upload failed: ${text.slice(0, 200)}`,
    );
  }

  const responseData = (await res.json()) as OneMinAssetResponse;
  const url = responseData.url ?? responseData.path;
  if (!url) {
    throw upstreamError(500, "Asset upload returned no URL");
  }
  return url;
}
