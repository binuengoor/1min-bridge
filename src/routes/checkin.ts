// ============================================================================
// 1min-bridge — Check-in Status & Manual Trigger Endpoints
// ============================================================================

import { Hono } from "hono";
import { getCheckinScheduler } from "../checkin/scheduler.js";
import type { Env } from "../types.js";

const app = new Hono<Env>();

/**
 * Returns current status of the auto check-in service, including
 * next scheduled run, balance, last run result, and execution history.
 */
const handleStatus = (c: any) => {
  const scheduler = getCheckinScheduler();
  const status = scheduler.getStatus();
  return c.json(status);
};

/**
 * Triggers an immediate manual check-in attempt.
 */
const handleRun = async (c: any) => {
  const scheduler = getCheckinScheduler();
  const result = await scheduler.runNow(true);

  if (!result.success) {
    return c.json(
      {
        success: false,
        message: "Manual check-in failed",
        result,
      },
      500,
    );
  }

  return c.json({
    success: true,
    message: "Manual check-in succeeded",
    result,
  });
};

/**
 * Triggers an immediate keep-alive credit ping.
 */
const handleKeepAlive = async (c: any) => {
  const scheduler = getCheckinScheduler();
  const apiKey = c.get("oneMinApiKey");
  const result = await scheduler.runKeepAliveNow(apiKey);

  if (!result.success) {
    return c.json(
      {
        success: false,
        message: "Credit keep-alive failed",
        result,
      },
      500,
    );
  }

  return c.json({
    success: true,
    message: "Credit keep-alive succeeded",
    result,
  });
};

app.get("/v1/checkin/status", handleStatus);
app.post("/v1/checkin/run", handleRun);
app.post("/v1/checkin/keepalive", handleKeepAlive);

app.get("/api/checkin/status", handleStatus);
app.post("/api/checkin/run", handleRun);
app.post("/api/checkin/keepalive", handleKeepAlive);

export default app;
