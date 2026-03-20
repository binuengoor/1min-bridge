// ============================================================================
// 1min-relay — Health & Root Endpoints
// ============================================================================

import { Hono } from "hono";
import { getModelData } from "../model-registry.js";
import type { Env } from "../types.js";

const app = new Hono<Env>();

app.get("/", (c) => {
  return c.text(
    [
      "1min-relay is running!",
      "",
      "OpenAI-compatible endpoints:",
      "  GET  /v1/models",
      "  GET  /v1/models/:modelId",
      "  POST /v1/chat/completions",
      "  POST /v1/images/generations",
      "  POST /v1/audio/transcriptions",
      "  POST /v1/audio/translations",
      "",
      "Operational:",
      "  GET  /health",
    ].join("\n"),
  );
});

app.get("/health", async (c) => {
  try {
    const data = await getModelData();
    return c.json({
      status: "ok",
      models: {
        chat: data.chatModelIds.length,
        image: data.imageModelIds.length,
        speech: data.speechModelIds.length,
        total: data.entries.length,
      },
      cacheAge: Math.round((Date.now() - data.fetchedAt) / 1000),
    });
  } catch {
    return c.json({ status: "degraded", error: "Model registry unavailable" }, 503);
  }
});

export default app;
