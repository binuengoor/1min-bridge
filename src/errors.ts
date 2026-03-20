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
  return new RelayError(
    `Upstream 1min.ai API error (${status})${body ? `: ${body.slice(0, 200)}` : ""}`,
    502,
    "api_error",
    "upstream_error",
  );
}

export function internalError(msg = "Internal server error"): RelayError {
  return new RelayError(msg, 500, "api_error", "internal_error");
}

/** Send a RelayError as an OpenAI-compatible JSON response */
export function sendError(c: Context<Env>, err: RelayError): Response {
  return c.json(err.toJSON(), err.status as 200);
}
