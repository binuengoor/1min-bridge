// ============================================================================
// 1min-bridge — Automated Daily Check-in Scheduler
// ============================================================================

import { config } from "../config.js";
import { OneMinCheckinClient } from "./client.js";
import { dispatchCheckinNotification } from "./notifier.js";
import type { CheckinConfig, CheckinResult, CheckinStatus } from "../types.js";

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
   * Returns the current status of the check-in service.
   */
  public getStatus(): CheckinStatus {
    const isConfigured = Boolean(this.config.email && this.config.password);

    return {
      enabled: this.config.enabled,
      isConfigured,
      lastRun: this.lastResult,
      nextScheduledRun: this.nextRunDate ? this.nextRunDate.toISOString() : undefined,
      currentBalance: this.lastResult?.finalCredit,
      totalCheckins: this.totalCheckins,
      successfulCheckins: this.successfulCheckins,
      history: this.history,
    };
  }
}
