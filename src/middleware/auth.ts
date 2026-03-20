// ============================================================================
// 1min-relay — Auth Middleware
// Extracts Bearer token and passes 1min.ai API key downstream via c.set()
// ============================================================================

import type { Context, Next } from "hono";
import { authenticationError, sendError } from "../errors.js";
import type { Env } from "../types.js";

/**
 * Auth middleware: validates Authorization: Bearer <key> header.
 * Stores the raw key in c.set("oneMinApiKey", key) for downstream use.
 */
export async function authMiddleware(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return sendError(
      c,
      authenticationError(
        "Missing or invalid Authorization header. Use: Bearer <api-key>",
      ),
    );
  }

  const apiKey = auth.slice(7).trim();
  if (!apiKey) {
    return sendError(c, authenticationError("Empty API key"));
  }

  c.set("oneMinApiKey", apiKey);
  await next();
}
