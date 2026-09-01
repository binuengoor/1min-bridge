// ============================================================================
// 1min-bridge — Main Entry Point (Universal Dual-Runtime Gateway)
// ============================================================================

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
import messagesRoutes from "./routes/messages.js";
import responsesRoutes from "./routes/responses.js";
import imageRoutes from "./routes/images.js";
import audioRoutes from "./routes/audio.js";
import webRoutes from "./routes/web.js";
import docsRoutes from "./routes/docs.js";
import youtubeRoutes from "./routes/youtube.js";
import metricsRoutes from "./routes/metrics.js";
import checkinRoutes from "./routes/checkin.js";
import dashboardRoutes from "./routes/dashboard.js";
import { getCheckinScheduler } from "./checkin/scheduler.js";
import { statsTracker } from "./stats.js";
import { calculateCredits } from "./utils/credits.js";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Active request tracking (for graceful shutdown in Node.js)
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

// CORS & Preflight handling
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, x-api-key, anthropic-version, X-Request-Id",
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

    // Record stats (skip internal polling endpoints)
    const reqPath = c.req.path;
    if (
      reqPath !== "/api/stats" &&
      reqPath !== "/dashboard" &&
      reqPath !== "/stats" &&
      reqPath !== "/health" &&
      reqPath !== "/v1/metrics"
    ) {
      let credits = c.get("credits");
      const model = c.get("model");
      const promptTokens = c.get("promptTokens");
      const completionTokens = c.get("completionTokens");

      if (credits === undefined && model) {
        credits = await calculateCredits(model, promptTokens, completionTokens);
      }

      statsTracker.recordRequest({
        method: c.req.method,
        path: reqPath,
        model,
        status: c.res.status,
        durationMs: ms,
        promptTokens,
        completionTokens,
        credits: credits ?? 0,
        requestId,
      });
    }
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
app.route("/", checkinRoutes);
app.route("/", dashboardRoutes);

// ---------------------------------------------------------------------------
// Protected routes (auth + rate limit)
// ---------------------------------------------------------------------------

const rateLimit = rateLimitMiddleware({ maxRequests: 60, windowMs: 60_000 });

app.use("/v1/chat/*", authMiddleware, rateLimit);
app.use("/v1/messages", authMiddleware, rateLimit);
app.use("/v1/messages/*", authMiddleware, rateLimit);
app.use("/v1/responses", authMiddleware, rateLimit);
app.use("/v1/responses/*", authMiddleware, rateLimit);
app.use("/v1/images/*", authMiddleware, rateLimit);
app.use("/v1/audio/*", authMiddleware, rateLimit);
app.use("/v1/search", authMiddleware, rateLimit);
app.use("/v1/web/*", authMiddleware, rateLimit);
app.use("/v1/engines/*", authMiddleware, rateLimit);

app.route("/", chatRoutes);
app.route("/", messagesRoutes);
app.route("/", responsesRoutes);
app.route("/", imageRoutes);
app.route("/", audioRoutes);
app.route("/", webRoutes);
app.route("/", youtubeRoutes);

// ---------------------------------------------------------------------------
// Node.js Server Startup & Graceful Shutdown
// ---------------------------------------------------------------------------

let server: any = null;

const isMainModule =
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  (process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js") ||
    process.argv[1].endsWith("src/index.ts") ||
    process.argv[1].endsWith("dist/index.js")) &&
  !process.env.CF_PAGES &&
  !process.env.WORKER;

if (isMainModule && typeof process !== "undefined" && process.versions?.node) {
  // Dynamically import @hono/node-server when running as main in Node.js
  import("@hono/node-server").then(({ serve }) => {
    console.log("1min-bridge starting...");
    console.log(`  Port:          ${config.port}`);
    console.log(`  Models URL:    ${config.oneMinModelsUrl}`);
    console.log(`  Cache TTL:     ${config.cacheTtlMs / 1000}s`);
    console.log(`  Log level:     ${config.logLevel}`);
    console.log(`  Log format:    ${config.logFormat}`);
    console.log(`  Allowed:       ${config.allowedModels?.join(", ") ?? "(all)"}`);

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

    server = serve({ fetch: app.fetch, port: config.port }, (info) => {
      console.log(`Listening on http://0.0.0.0:${info.port}`);
    });

    // Start auto check-in scheduler (if enabled / configured)
    const checkinScheduler = getCheckinScheduler();
    checkinScheduler.start();

    const DRAIN_TIMEOUT_MS = 10_000;
    function shutdown(signal: string): void {
      console.log(`\n${signal} received, shutting down...`);
      checkinScheduler.stop();
      if (server) {
        server.close(() => {
          console.log("Server closed (no longer accepting connections)");
        });
      }

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
  });
}

export { app, server };
export default app;
