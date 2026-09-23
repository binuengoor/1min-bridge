// ============================================================================
// 1min-bridge — 1min.ai Direct-API Check-in Client
// ============================================================================

import crypto from "node:crypto";
import { generateTotp } from "./totp.js";
import type { CheckinResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_MS = 3_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export interface CheckinClientOptions {
  email?: string;
  password?: string;
  totpSecret?: string;
  timeoutMs?: number;
  settleMs?: number;
  baseUrl?: string;
}

export class OneMinCheckinClient {
  private email?: string;
  private password?: string;
  private totpSecret?: string;
  private deviceId: string;
  private timeoutMs: number;
  private settleMs: number;
  private baseUrl: string;

  constructor(options: CheckinClientOptions = {}) {
    this.email = options.email;
    this.password = options.password;
    this.totpSecret = options.totpSecret ? options.totpSecret.trim() : undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.baseUrl = options.baseUrl ?? "https://api.1min.ai";
    this.deviceId = this.generateDeviceId();
  }

  /**
   * Generates a realistic Mixpanel / Client Device ID matching the 1min.ai web app format.
   */
  private generateDeviceId(): string {
    const randomHex = (len: number) => crypto.randomBytes(len).toString("hex").slice(0, len);
    return `$device:${randomHex(16)}-${randomHex(15)}-${randomHex(8)}-${randomHex(6)}-${randomHex(16)}`;
  }

  /**
   * Builds request headers simulating the authentic 1min.ai web frontend.
   */
  private buildHeaders(authToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Host: "api.1min.ai",
      "Content-Type": "application/json",
      "X-Auth-Token": authToken ? `Bearer ${authToken}` : "Bearer",
      "Mp-Identity": this.deviceId,
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Origin: "https://app.1min.ai",
      Referer: "https://app.1min.ai/",
    };
    return headers;
  }

  /**
   * Safe fetch with AbortController timeout.
   */
  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Executes a check-in attempt with exponential backoff retries.
   */
  public async execute(manual = false): Promise<CheckinResult> {
    if (!this.email || !this.password) {
      return {
        success: false,
        timestamp: new Date().toISOString(),
        error: "Missing check-in credentials (email or password not configured)",
        manual,
      };
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(
          `[Check-in] Starting daily check-in attempt ${attempt}/${MAX_RETRIES} for ${this.maskEmail(this.email)}...`,
        );

        const result = await this.performCheckinFlow();
        return {
          ...result,
          timestamp: new Date().toISOString(),
          attemptCount: attempt,
          manual,
        };
      } catch (err) {
        lastError = err as Error;
        console.warn(`[Check-in] Attempt ${attempt} failed: ${lastError.message}`);

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000;
          console.log(`[Check-in] Retrying in ${Math.round(delay)}ms...`);
          await new Promise((res) => setTimeout(res, delay));
        }
      }
    }

    return {
      success: false,
      timestamp: new Date().toISOString(),
      error: lastError?.message || "Check-in failed after retries",
      attemptCount: MAX_RETRIES,
      manual,
    };
  }

  /**
   * Internal flow: Login -> MFA (if required) -> Unread notifications -> Fetch balance.
   */
  private async performCheckinFlow(): Promise<Omit<CheckinResult, "timestamp" | "manual">> {
    // 1. Login
    const loginRes = await this.fetchWithTimeout(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        email: this.email,
        password: this.password,
      }),
    });

    if (!loginRes.ok) {
      const errData = await loginRes.json().catch(() => ({}));
      const msg =
        (errData as { message?: string }).message ||
        (loginRes.status === 401
          ? "Invalid email or password"
          : loginRes.status === 429
            ? "Rate limited by 1min.ai"
            : `HTTP ${loginRes.status}`);
      throw new Error(`Login failed: ${msg}`);
    }

    let authData = await loginRes.json();

    // 2. Handle TOTP MFA if requested
    if (authData.user?.mfaRequired) {
      if (!this.totpSecret) {
        throw new Error("2FA / TOTP verification required by account, but CHECKIN_TOTP_SECRET is not configured");
      }

      const totpCode = generateTotp(this.totpSecret);
      console.log(`[Check-in] Generated TOTP code for MFA verification`);

      const mfaRes = await this.fetchWithTimeout(`${this.baseUrl}/auth/mfa/verify`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          code: totpCode,
          token: authData.user.token,
        }),
      });

      if (!mfaRes.ok) {
        const mfaErr = await mfaRes.json().catch(() => ({}));
        throw new Error(
          `MFA verification failed: ${(mfaErr as { message?: string }).message || mfaRes.statusText}`,
        );
      }

      authData = await mfaRes.json();
    }

    const user = authData.user;
    if (!user || !user.teams || user.teams.length === 0) {
      return {
        success: true,
        userName: user?.email?.split("@")[0] || "User",
      };
    }

    const authToken = authData.token || user.token;
    const userUuid = user.uuid;

    // 3. Locate primary team
    let targetTeam = user.teams.find(
      (t: any) => t.team?.subscription?.userId === userUuid,
    );
    if (!targetTeam && user.teams.length > 0) {
      targetTeam = user.teams[0];
    }

    const teamId = targetTeam?.teamId || targetTeam?.team?.uuid;
    const userName = targetTeam?.userName || user.email?.split("@")[0] || "User";
    const usedCredit = targetTeam?.usedCredit || 0;
    const initialCredit = targetTeam?.team?.credit || 0;

    const headers = this.buildHeaders(authToken);

    // 4. Trigger check-in by checking unread notifications (same as web portal SPA)
    await this.checkUnreadNotifications(headers);

    // 5. Wait for check-in bonus reward to settle
    await new Promise((resolve) => setTimeout(resolve, this.settleMs));

    // 6. Fetch final credits from team credits endpoint
    let finalCredit = initialCredit;
    if (teamId && authToken) {
      const latest = await this.fetchCredits(teamId, headers);
      if (latest !== null) {
        finalCredit = latest;
      }
    }

    const creditDiff = finalCredit - initialCredit;
    const totalCredit = finalCredit + usedCredit;
    const availablePercent =
      totalCredit > 0 ? ((finalCredit / totalCredit) * 100).toFixed(1) : "0";

    console.log(
      `[Check-in] Success! User: ${userName}, Balance: ${finalCredit.toLocaleString()}` +
        (creditDiff > 0 ? ` (+${creditDiff.toLocaleString()} credits reward!)` : ""),
    );

    return {
      success: true,
      userName,
      teamId,
      initialCredit,
      finalCredit,
      creditDiff,
      availablePercent,
    };
  }

  /**
   * Fetches unread notifications to trigger the daily check-in reward.
   */
  private async checkUnreadNotifications(headers: Record<string, string>): Promise<void> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/notifications/unread`, { headers });
      if (res.ok) {
        const data = await res.json();
        console.log(`[Check-in] Notification check acknowledged (${data.count || 0} unread)`);
      }
    } catch (err) {
      console.warn(`[Check-in] Notification check warning: ${(err as Error).message}`);
    }
  }

  /**
   * Queries the latest credit balance for a team.
   */
  private async fetchCredits(teamId: string, headers: Record<string, string>): Promise<number | null> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/teams/${teamId}/credits`, { headers });
      if (res.ok) {
        const data = await res.json();
        return typeof data.credit === "number" ? data.credit : null;
      }
    } catch (err) {
      console.warn(`[Check-in] Failed to fetch team credits: ${(err as Error).message}`);
    }
    return null;
  }

  private maskEmail(email: string): string {
    const at = email.indexOf("@");
    if (at <= 2) return "***";
    return `${email.slice(0, 2)}***${email.slice(at)}`;
  }
}
