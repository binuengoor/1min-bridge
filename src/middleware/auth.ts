// ============================================================================
// 1min-bridge — Auth Middleware
// Extracts Bearer token or falls back to server-side default API key
// ============================================================================

import type { Context, Next } from "hono";
import { config } from "../config.js";
import { authenticationError, sendError } from "../errors.js";
import type { Env } from "../types.js";

/**
 * Auth middleware: validates Authorization: Bearer <key> header.
 * Falls back to ONE_MIN_API_KEY env var if no header provided.
 * Stores the key in c.set("oneMinApiKey", key) for downstream use.
 */
export async function authMiddleware(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const auth = c.req.header("Authorization");

  if (auth?.startsWith("Bearer ")) {
    const apiKey = auth.slice(7).trim();
    if (!apiKey) {
      return sendError(c, authenticationError("Empty API key"));
    }
    c.set("oneMinApiKey", apiKey);
    await next();
    return;
  }

  // Fallback to server-side default key
  if (config.defaultApiKey) {
    c.set("oneMinApiKey", config.defaultApiKey);
    await next();
    return;
  }

  return sendError(
    c,
    authenticationError(
      "Missing Authorization header. Pass Bearer <api-key> or set ONE_MIN_API_KEY on the server.",
    ),
  );
}
