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
import { incrementCounter, observeHistogram } from "./metrics.js";
import type { Env } from "./types.js";

import healthRoutes from "./routes/health.js";
import modelRoutes from "./routes/models.js";
import chatRoutes from "./routes/chat.js";
import imageRoutes from "./routes/images.js";
import audioRoutes from "./routes/audio.js";
import docsRoutes from "./routes/docs.js";
import youtubeRoutes from "./routes/youtube.js";
import metricsRoutes from "./routes/metrics.js";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Active request tracking (for graceful shutdown)
// ---------------------------------------------------------------------------

let activeRequests = 0;

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function logRequest(
  method: string,
  path: string,
  status: number,
  latency: number,
  requestId: string,
): void {
  const forceJson =
    config.logFormat === "json" || process.env.NODE_ENV === "production";

  if (forceJson) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "info",
      method,
      path,
      status,
      latency,
      requestId: requestId.slice(0, 8),
    };
    console.log(JSON.stringify(entry));
  } else {
    console.log(
      `${method} ${path} -> ${status} (${latency}ms) [${requestId.slice(0, 8)}]`,
    );
  }
}

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

// Request ID, logging, metrics & active request tracking
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") ?? crypto.randomUUID();
  c.header("X-Request-Id", requestId);
  activeRequests++;
  const start = Date.now();

  try {
    await next();
  } finally {
    const ms = Date.now() - start;
    activeRequests--;

    logRequest(c.req.method, c.req.path, c.res.status, ms, requestId);

    // Metrics
    incrementCounter("1min_bridge_requests_total", {
      method: c.req.method,
      path: c.req.path,
      status: String(c.res.status),
    });
    observeHistogram(
      "1min_bridge_request_duration_seconds",
      { method: c.req.method, path: c.req.path },
      ms / 1000,
    );
  }
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
app.route("/", metricsRoutes);

// ---------------------------------------------------------------------------
// Protected routes (auth + rate limit)
// ---------------------------------------------------------------------------

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
    return rateLimitMiddleware({ maxRequests: 60, windowMs: 60_000 })(c, next);
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
console.log(`  Log format:    ${config.logFormat}`);
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

// ---------------------------------------------------------------------------
// Graceful shutdown with request draining
// ---------------------------------------------------------------------------

const DRAIN_TIMEOUT_MS = 10_000;

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("Server closed (no longer accepting connections)");
  });

  // Drain in-flight requests
  console.log(`Draining ${activeRequests} active request(s)...`);
  const drainStart = Date.now();

  const drainInterval = setInterval(() => {
    if (activeRequests <= 0) {
      clearInterval(drainInterval);
      console.log("All requests drained, exiting.");
      process.exit(0);
    }
    if (Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
      clearInterval(drainInterval);
      console.log(
        `Drain timeout (${DRAIN_TIMEOUT_MS}ms) reached with ${activeRequests} request(s) still active, forcing exit.`,
      );
      process.exit(1);
    }
  }, 100);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
