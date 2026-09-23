// ============================================================================
// 1min-relay — OpenAI-compatible Error Handling
// ============================================================================

import type { Context } from "hono";
import type { OpenAIErrorBody, Env } from "./types.js";

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly type: string,
    public readonly code?: string | null,
    public readonly param?: string | null,
  ) {
    super(message);
    this.name = "RelayError";
  }

  toJSON(): OpenAIErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param ?? null,
        code: this.code ?? null,
      },
    };
  }
}

export function authenticationError(msg = "Invalid API key"): RelayError {
  return new RelayError(msg, 401, "authentication_error", "invalid_api_key");
}

export function invalidRequestError(msg: string, code?: string): RelayError {
  return new RelayError(msg, 400, "invalid_request_error", code ?? null);
}

export function modelNotFoundError(_model: string): RelayError {
  return new RelayError(
    `Model '${_model}' not found`,
    404,
    "invalid_request_error",
    "model_not_found",
  );
}

export function rateLimitError(): RelayError {
  return new RelayError(
    "Rate limit exceeded. Please try again later.",
    429,
    "rate_limit_exceeded",
    "rate_limit_exceeded",
  );
}

export function upstreamError(status: number, body?: string): RelayError {
  const raw = body ?? "";
  // Preserve actionable upstream statuses so LiteLLM/Pi retry correctly.
  const passthrough = new Set([400, 401, 403, 404, 422, 429]);
  if (passthrough.has(status)) {
    const parsed = parseUpstreamErrorBody(raw);
    const type =
      status === 401
        ? "authentication_error"
        : status === 429
          ? "rate_limit_exceeded"
          : "invalid_request_error";
    const code = parsed.code ?? (status === 429 ? "rate_limit_exceeded" : status === 401 ? "invalid_api_key" : "upstream_error");
    const message = parsed.message
      ? `Upstream 1min.ai error (${status}): ${parsed.message}${parsed.details ? ` | details: ${parsed.details}` : ""}`
      : `Upstream 1min.ai API error (${status})${raw ? `: ${raw.slice(0, 500)}` : ""}`;
    return new RelayError(message, status, type, code);
  }
  return new RelayError(
    `Upstream 1min.ai API error (${status})${body ? `: ${body.slice(0, 200)}` : ""}`,
    502,
    "api_error",
    "upstream_error",
  );
}

function parseUpstreamErrorBody(raw: string): {
  message?: string;
  code?: string;
  details?: string;
} {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as {
      error?: { code?: string; message?: string; details?: Array<{ field?: string; message?: string }> | unknown };
      message?: string;
      code?: string;
    };
    const err = data.error;
    if (err && typeof err === "object") {
      const details = Array.isArray(err.details)
        ? err.details
            .map((d) =>
              typeof d === "object" && d !== null
                ? `${(d as { field?: string }).field ?? "field"}: ${(d as { message?: string }).message ?? JSON.stringify(d)}`
                : String(d),
            )
            .join("; ")
            .slice(0, 500)
        : undefined;
      return {
        message: err.message ?? data.message,
        code: err.code ?? data.code,
        details,
      };
    }
    if (typeof data.message === "string") return { message: data.message, code: data.code };
  } catch {
    // raw text body — caller slices it
  }
  return {};
}

export function internalError(msg = "Internal server error"): RelayError {
  return new RelayError(msg, 500, "api_error", "internal_error");
}

/** Send a RelayError as an OpenAI-compatible JSON response */
export function sendError(c: Context<Env>, err: RelayError): Response {
  return c.json(err.toJSON(), err.status as 200);
}
