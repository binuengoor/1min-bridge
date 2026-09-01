// ============================================================================
// 1min-bridge — 1min.ai API Adapter
// Supports: UNIFY_CHAT_WITH_AI (Chat API) and AI Feature API
// ============================================================================

import { config } from "../config.js";
import type {
  OneMinRequestBody,
  OneMinResponse,
  OneMinAssetResponse,
} from "../types.js";
import { upstreamError } from "../errors.js";

const FETCH_TIMEOUT_MS = 120_000; // 2 min for generation requests
const UPLOAD_TIMEOUT_MS = 30_000; // 30s for asset uploads

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "API-KEY": apiKey,
  };
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
