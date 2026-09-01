// ============================================================================
// 1min-bridge — In-Memory Stats & Analytics Tracker
// ============================================================================

import { getCheckinScheduler } from "./checkin/scheduler.js";
import type { CheckinStatus } from "./types.js";

const MAX_RECENT_REQUESTS = 20;

export interface RequestRecord {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  model?: string;
  status: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  credits: number;
}

export interface ModelStat {
  model: string;
  requests: number;
  credits: number;
  promptTokens: number;
  completionTokens: number;
  lastUsed: string;
}

export interface EndpointStat {
  path: string;
  method: string;
  requests: number;
  credits: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
}

export interface StatsSummary {
  uptimeSeconds: number;
  serverTime: string;
  totalRequests: number;
  totalCreditsConsumed: number;
  models: ModelStat[];
  endpoints: EndpointStat[];
  recentRequests: RequestRecord[];
  checkin: CheckinStatus;
}

class StatsTracker {
  private startTime = Date.now();
  private totalRequests = 0;
  private totalCreditsConsumed = 0;
  private modelStats: Map<string, { requests: number; credits: number; promptTokens: number; completionTokens: number; lastUsed: string }> = new Map();
  private endpointStats: Map<string, { method: string; path: string; requests: number; credits: number; successCount: number; errorCount: number; totalDurationMs: number }> = new Map();
  private recentRequests: RequestRecord[] = [];

  public recordRequest(data: {
    method: string;
    path: string;
    model?: string;
    status: number;
    durationMs: number;
    promptTokens?: number;
    completionTokens?: number;
    credits?: number;
    requestId?: string;
  }): void {
    const credits = data.credits ?? 0;
    this.totalRequests++;
    this.totalCreditsConsumed += credits;

    const now = new Date().toISOString();

    // 1. Model Stats
    if (data.model) {
      const cleanModel = data.model.split(":")[0] || data.model;
      const existing = this.modelStats.get(cleanModel) || {
        requests: 0,
        credits: 0,
        promptTokens: 0,
        completionTokens: 0,
        lastUsed: now,
      };

      existing.requests++;
      existing.credits += credits;
      existing.promptTokens += data.promptTokens ?? 0;
      existing.completionTokens += data.completionTokens ?? 0;
      existing.lastUsed = now;
      this.modelStats.set(cleanModel, existing);
    }

    // 2. Endpoint Stats
    // Normalize path to remove trailing slash or dynamic subpaths
    const normPath = data.path.replace(/\/+$/, "") || "/";
    const endpointKey = `${data.method} ${normPath}`;
    const existingEndpoint = this.endpointStats.get(endpointKey) || {
      method: data.method,
      path: normPath,
      requests: 0,
      credits: 0,
      successCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
    };

    existingEndpoint.requests++;
    existingEndpoint.credits += credits;
    existingEndpoint.totalDurationMs += data.durationMs;
    if (data.status >= 200 && data.status < 400) {
      existingEndpoint.successCount++;
    } else {
      existingEndpoint.errorCount++;
    }
    this.endpointStats.set(endpointKey, existingEndpoint);

    // 3. Ring buffer of recent requests
    const record: RequestRecord = {
      id: (data.requestId || Math.random().toString(36).substring(2, 10)).slice(0, 8),
      timestamp: now,
      method: data.method,
      path: normPath,
      model: data.model,
      status: data.status,
      durationMs: Math.round(data.durationMs),
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      credits: Math.round(credits * 10) / 10,
    };

    this.recentRequests.unshift(record);
    if (this.recentRequests.length > MAX_RECENT_REQUESTS) {
      this.recentRequests.pop();
    }
  }

  public getSummary(): StatsSummary {
    const models: ModelStat[] = Array.from(this.modelStats.entries()).map(([model, stat]) => ({
      model,
      requests: stat.requests,
      credits: Math.round(stat.credits * 10) / 10,
      promptTokens: stat.promptTokens,
      completionTokens: stat.completionTokens,
      lastUsed: stat.lastUsed,
    })).sort((a, b) => b.credits - a.credits || b.requests - a.requests);

    const endpoints: EndpointStat[] = Array.from(this.endpointStats.values()).map((stat) => ({
      method: stat.method,
      path: stat.path,
      requests: stat.requests,
      credits: Math.round(stat.credits * 10) / 10,
      successCount: stat.successCount,
      errorCount: stat.errorCount,
      avgDurationMs: Math.round(stat.totalDurationMs / (stat.requests || 1)),
    })).sort((a, b) => b.credits - a.credits || b.requests - a.requests);

    const checkinStatus = getCheckinScheduler().getStatus();

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      serverTime: new Date().toISOString(),
      totalRequests: this.totalRequests,
      totalCreditsConsumed: Math.round(this.totalCreditsConsumed * 10) / 10,
      models,
      endpoints,
      recentRequests: this.recentRequests,
      checkin: checkinStatus,
    };
  }
}

export const statsTracker = new StatsTracker();
