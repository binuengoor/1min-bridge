// ============================================================================
// 1min-bridge — GET /metrics (Prometheus exposition format)
// ============================================================================

import { Hono } from "hono";
import { getMetricsText } from "../metrics.js";
import type { Env } from "../types.js";

const app = new Hono<Env>();

app.get("/metrics", (c) => {
  return c.text(getMetricsText(), 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

export default app;
