// ============================================================================
// 1min-bridge — Automated Daily Check-in Scheduler
// ============================================================================

import { config } from "../config.js";
import { OneMinCheckinClient } from "./client.js";
import { dispatchCheckinNotification } from "./notifier.js";
import { getCheapestChatModels } from "../model-registry.js";
import type {
  CheckinConfig,
  CheckinResult,
  CheckinStatus,
  KeepAliveResult,
} from "../types.js";

const MAX_HISTORY_LENGTH = 30;

let schedulerInstance: CheckinScheduler | null = null;

export function getCheckinScheduler(configOverride?: CheckinConfig): CheckinScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new CheckinScheduler(configOverride ?? config.checkin);
  }
  return schedulerInstance;
}

export class CheckinScheduler {
  private config: CheckinConfig;
  private client: OneMinCheckinClient;
  private timer?: NodeJS.Timeout;
  private isExecuting = false;
  private lastResult?: CheckinResult;
  private nextRunDate?: Date;
  private history: CheckinResult[] = [];
  private totalCheckins = 0;
  private successfulCheckins = 0;
  private lastKeepAliveResult?: KeepAliveResult;

  constructor(config: CheckinConfig) {
    this.config = config;
    this.client = new OneMinCheckinClient({
      email: config.email,
      password: config.password,
      totpSecret: config.totpSecret,
      settleMs: config.settleMs,
    });
  }

  /**
   * Starts the check-in scheduler service.
   */
  public start(): void {
    if (!this.config.enabled) {
      console.log("[Check-in Scheduler] Auto check-in is disabled");
      return;
    }

    if (!this.config.email || !this.config.password) {
      console.warn(
        "[Check-in Scheduler] Auto check-in enabled but missing CHECKIN_EMAIL or CHECKIN_PASSWORD",
      );
      return;
    }

    console.log(
      `[Check-in Scheduler] Starting scheduler (Target: ${this.config.utcHour}:00 UTC, Jitter: 0-${this.config.jitterMinutes}m, 2FA: ${this.config.totpSecret ? "Configured" : "None"})`,
    );

    if (this.config.onStartup) {
      // Delay slightly (5s) to allow main HTTP server and routes to bind first.
      // Manual=true so the daily timer armed below is left untouched.
      setTimeout(() => {
        this.runNow(true).catch((err) => {
          console.error("[Check-in Scheduler] Startup run failed:", err);
        });
      }, 5_000);
    }

    this.scheduleNextRun();
  }

  /**
   * Stops any pending timer.
   */
  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    console.log("[Check-in Scheduler] Stopped");
  }

  /**
   * Triggers an immediate check-in run.
   */
  public async runNow(manual = true): Promise<CheckinResult> {
    if (this.isExecuting) {
      return {
        success: false,
        timestamp: new Date().toISOString(),
        error: "Check-in already in progress",
        manual,
      };
    }

    this.isExecuting = true;

    try {
      const result = await this.client.execute(manual);
      this.lastResult = result;
      this.totalCheckins++;

      if (result.success) {
        this.successfulCheckins++;
      }

      this.history.unshift(result);
      if (this.history.length > MAX_HISTORY_LENGTH) {
        this.history.pop();
      }

      // Dispatch Telegram / Webhook notification
      await dispatchCheckinNotification(this.config, result);

      // Trigger periodic 30-day lifetime credit keep-alive ping if due
      if (this.config.keepAliveEnabled) {
        const intervalMs = (this.config.keepAliveDays ?? 7) * 24 * 60 * 60 * 1000;
        const lastTimestamp = this.lastKeepAliveResult?.timestamp
          ? new Date(this.lastKeepAliveResult.timestamp).getTime()
          : 0;
        const isDue = Date.now() - lastTimestamp >= intervalMs;

        if (isDue) {
          await this.runKeepAliveNow().catch((err) => {
            console.warn("[Check-in Scheduler] Keep-alive invocation warning:", err);
          });
        }
      }

      return result;
    } finally {
      this.isExecuting = false;
      // Timer callback already re-arms via scheduleNextRun at fire time;
      // do NOT re-schedule here to avoid double-arming/drift.
    }
  }

  /**
   * Calculates the next UTC trigger time and arms a timer.
   */
  private scheduleNextRun(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const now = new Date();
    const next = new Date(now);

    next.setUTCHours(this.config.utcHour, 0, 0, 0);

    // If target hour has already passed today, schedule for tomorrow
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    // Add randomized jitter to avoid predictable exact-second hits
    const jitterMs = Math.floor(Math.random() * this.config.jitterMinutes * 60 * 1000);
    const scheduledTime = new Date(next.getTime() + jitterMs);

    this.nextRunDate = scheduledTime;
    const msUntilRun = scheduledTime.getTime() - Date.now();

    console.log(
      `[Check-in Scheduler] Next scheduled check-in: ${scheduledTime.toISOString()} (in ${Math.round(msUntilRun / 60000)} minutes)`,
    );

    this.timer = setTimeout(() => {
      // Re-arm first so the daily cadence survives slow/failed runs.
      this.scheduleNextRun();
      this.runNow(false).catch((err) => {
        console.error("[Check-in Scheduler] Scheduled check-in error:", err);
      });
    }, msUntilRun);
  }

  /**
   * Executes a minimal 1-token prompt to maintain 30-day lifetime credit eligibility.
   * Dynamically evaluates the lowest-cost models and cascades across up to 3 candidates.
   */
  public async runKeepAliveNow(apiKeyOverride?: string): Promise<KeepAliveResult> {
    const apiKey = apiKeyOverride || config.defaultApiKey;

    if (!apiKey) {
      const res: KeepAliveResult = {
        success: false,
        timestamp: new Date().toISOString(),
        model: "none",
        error: "Missing API key for keep-alive (ONE_MIN_API_KEY not configured)",
      };
      this.lastKeepAliveResult = res;
      return res;
    }

    // 1. Dynamically find the 3 cheapest active chat models from the live catalog
    const cheapestModels = await getCheapestChatModels(3).catch(() => [
      "qwen3.7-flash",
      "open-mistral-nemo",
      "ministral-14b-latest",
    ]);

    // Ensure candidates list is populated, prioritizing user preference if configured
    const candidateSet = new Set<string>();
    if (this.config.keepAliveModel && this.config.keepAliveModel !== "auto") {
      candidateSet.add(this.config.keepAliveModel);
    }
    for (const m of cheapestModels) {
      candidateSet.add(m);
    }
    const candidates = Array.from(candidateSet).slice(0, 3);

    console.log(
      `[Keep-Alive] 3-model cascade candidates (lowest credit cost): ${candidates.join(" -> ")}`,
    );

    const errors: string[] = [];

    // 2. Cascade down candidate models until one succeeds
    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i] || "qwen3.7-flash";
      try {
        console.log(
          `[Keep-Alive] Attempt ${i + 1}/${candidates.length}: Sending 1-token ping to ${model}...`,
        );

        const response = await fetch("https://api.1min.ai/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "keepalive" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status}: ${errText.slice(0, 100)}`);
        }

        const data = (await response.json().catch(() => ({}))) as {
          usage?: { total_tokens?: number };
        };
        const tokensUsed = data.usage?.total_tokens ?? 1;

        console.log(
          `[Keep-Alive] Successfully consumed minimal credits (${tokensUsed} tokens) on ${model} to maintain 30-day lifetime bonus eligibility.`,
        );

        const res: KeepAliveResult = {
          success: true,
          timestamp: new Date().toISOString(),
          model,
          tokensUsed,
        };
        this.lastKeepAliveResult = res;
        return res;
      } catch (err) {
        const errorMsg = (err as Error).message;
        errors.push(`${model}: ${errorMsg}`);
        console.warn(
          `[Keep-Alive] Candidate ${i + 1}/${candidates.length} (${model}) failed: ${errorMsg}. Cascading to next model...`,
        );
      }
    }

    const summaryError = `All 3 cascade models failed: ${errors.join(" | ")}`;
    console.error(`[Keep-Alive] ${summaryError}`);

    const res: KeepAliveResult = {
      success: false,
      timestamp: new Date().toISOString(),
      model: candidates[0] || "unknown",
      error: summaryError,
    };
    this.lastKeepAliveResult = res;
    return res;
  }

  /**
   * Returns the current status of the check-in service.
   */
  public getStatus(): CheckinStatus {
    const isConfigured = Boolean(this.config.email && this.config.password);
    const keepAliveDays = this.config.keepAliveDays ?? 7;
    const nextKeepAliveDue = this.lastKeepAliveResult?.timestamp
      ? new Date(
          new Date(this.lastKeepAliveResult.timestamp).getTime() +
            keepAliveDays * 24 * 60 * 60 * 1000,
        ).toISOString()
      : undefined;

    return {
      enabled: this.config.enabled,
      isConfigured,
      lastRun: this.lastResult,
      nextScheduledRun: this.nextRunDate ? this.nextRunDate.toISOString() : undefined,
      currentBalance: this.lastResult?.finalCredit,
      totalCheckins: this.totalCheckins,
      successfulCheckins: this.successfulCheckins,
      history: this.history,
      keepAlive: {
        enabled: Boolean(this.config.keepAliveEnabled),
        intervalDays: keepAliveDays,
        model: this.config.keepAliveModel ?? "qwen3.7-flash",
        lastRun: this.lastKeepAliveResult,
        nextRunDue: nextKeepAliveDue,
      },
    };
  }
}
