// ============================================================================
// 1min-relay — Main Entry Point
// ============================================================================

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { getModelData } from "./model-registry.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { RelayError, sendError } from "./errors.js";
import type { Env } from "./types.js";

import healthRoutes from "./routes/health.js";
import modelRoutes from "./routes/models.js";
import chatRoutes from "./routes/chat.js";
import imageRoutes from "./routes/images.js";
import audioRoutes from "./routes/audio.js";
import docsRoutes from "./routes/docs.js";
import youtubeRoutes from "./routes/youtube.js";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// CORS
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }
  c.header("Access-Control-Allow-Origin", "*");
  await next();
});

// Request ID & logging
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") ?? crypto.randomUUID();
  c.header("X-Request-Id", requestId);
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(
    `${c.req.method} ${c.req.path} -> ${c.res.status} (${ms}ms) [${requestId.slice(0, 8)}]`,
  );
});

// Global error handler
app.onError((err, c) => {
  if (err instanceof RelayError) {
    return sendError(c, err);
  }
  console.error("Unhandled error:", err);
  return sendError(
    c,
    new RelayError("Internal server error", 500, "api_error", "internal_error"),
  );
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: {
        message: `Not found: ${c.req.method} ${c.req.path}`,
        type: "invalid_request_error",
        code: "not_found",
      },
    },
    404,
  );
});

// ---------------------------------------------------------------------------
// Public routes (no auth needed)
// ---------------------------------------------------------------------------

app.route("/", healthRoutes);
app.route("/", modelRoutes);
app.route("/", docsRoutes);

// ---------------------------------------------------------------------------
// Protected routes (auth + rate limit)
// ---------------------------------------------------------------------------

// Auth + rate limit for protected routes only
const protectedPaths = ["/v1/chat", "/v1/images", "/v1/audio", "/v1/engines"];
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (protectedPaths.some((p) => path.startsWith(p))) {
    return await authMiddleware(c, next);
  } else {
    await next();
  }
});
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (protectedPaths.some((p) => path.startsWith(p))) {
    await rateLimitMiddleware({ maxRequests: 60, windowMs: 60_000 })(c, next);
  } else {
    await next();
  }
});

app.route("/", chatRoutes);
app.route("/", imageRoutes);
app.route("/", audioRoutes);
app.route("/", youtubeRoutes);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.log("1min-relay starting...");
console.log(`  Port:          ${config.port}`);
console.log(`  Models URL:    ${config.oneMinModelsUrl}`);
console.log(`  Cache TTL:     ${config.cacheTtlMs / 1000}s`);
console.log(`  Log level:     ${config.logLevel}`);
console.log(`  Allowed:       ${config.allowedModels?.join(", ") ?? "(all)"}`);

// Pre-fetch models on startup
getModelData()
  .then((data) => {
    console.log(
      `  Models loaded: ${data.chatModelIds.length} chat, ${data.imageModelIds.length} image, ${data.speechModelIds.length} speech`,
    );
  })
  .catch((err) => {
    console.warn(
      "  Initial model fetch failed (will retry on first request):",
      (err as Error).message,
    );
  });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Listening on http://0.0.0.0:${info.port}`);
});

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
