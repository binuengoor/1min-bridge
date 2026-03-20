// ============================================================================
// 1min-bridge — 1min.ai API Adapter
// Supports: legacy CHAT_WITH_AI and structured UNIFY_CHAT_WITH_AI
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

/** Non-streaming feature call */
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

/** Streaming feature call (legacy CHAT_WITH_AI) — returns the upstream Response for passthrough */
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

/**
 * Streaming feature call using UNIFY_CHAT_WITH_AI.
 * This uses structured SSE events: llm_chunk, llm_result, ai_record_result.
 * Returns a ReadableStream emitting clean content chunks.
 */
export async function callFeatureStreamStructured(
  apiKey: string,
  body: OneMinRequestBody,
): Promise<ReadableStream<Uint8Array>> {
  // Force the type to UNIFY_CHAT_WITH_AI
  const structuredBody = { ...body, type: "UNIFY_CHAT_WITH_AI" };

  const res = await fetch(config.oneMinStreamingUrl, {
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
    throw upstreamError(500, "No response body from UNIFY_CHAT_WITH_AI");
  }

  // Parse the structured SSE and emit clean content chunks
  const upstream = res.body;
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      const encoder = new TextEncoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEvent = "";

          for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.slice(6).trim();
              continue;
            }

            if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trim();

              // llm_chunk events contain content pieces
              if (currentEvent === "llm_chunk") {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content) {
                    // Emit as SSE data line for compatibility
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(parsed.content)}\n\n`),
                    );
                  }
                } catch {
                  // If not JSON, emit as raw content
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                }
              }

              // llm_result has the full response — skip, we stream via llm_chunk
              // ai_record_result has metadata — skip
              currentEvent = "";
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(`data: ${buffer.trim()}\n\n`));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        console.error("Structured stream parse error:", err);
        controller.error(err);
      }
    },
  });
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
      const uint8 = Uint8Array.from(atob(base64Part), (c) => c.charCodeAt(0));
      return uploadBlob(apiKey, uint8, mimeType);
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
