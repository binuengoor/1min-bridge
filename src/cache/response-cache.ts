// ============================================================================
// 1min-bridge — Response cache (in-memory LRU + TTL) with in-flight coalescing
// 1min.ai bills cached prompt tokens at full price, so the only way to save
// credits is to not call upstream at all for identical deterministic requests.
// ============================================================================

import { createHash } from "node:crypto";
import { config } from "../config.js";
import { incrementCounter } from "../metrics.js";
import type { ToolCall } from "../types.js";

export interface CachedChat {
  content: string | null;
  toolCalls: ToolCall[] | null;
  finishReason: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface Entry {
  value: CachedChat;
  expires: number;
}

const store = new Map<string, Entry>(); // insertion order == LRU order
const inflight = new Map<string, Promise<CachedChat>>();

export type CacheMode = "off" | "auto" | "on";

/**
 * Decide whether a request may use the cache.
 *  - `x-bridge-cache: bypass|off` or `Cache-Control: no-cache|no-store` -> off
 *  - `x-bridge-cache: on`                                              -> on
 *  - otherwise only deterministic requests (temperature === 0)         -> on
 */
export function resolveCacheMode(
  headers: { get(name: string): string | null | undefined },
  temperature: number | undefined,
): boolean {
  if (!config.responseCache.enabled) return false;
  const h = (headers.get("x-bridge-cache") ?? "").toLowerCase();
  if (h === "bypass" || h === "off" || h === "false") return false;
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (cc.includes("no-cache") || cc.includes("no-store")) return false;
  if (h === "on" || h === "true") return true;
  return temperature === 0;
}

export function cacheKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function cacheGet(key: string): CachedChat | null {
  const e = store.get(key);
  if (!e) return null;
  if (e.expires < Date.now()) {
    store.delete(key);
    return null;
  }
  store.delete(key); // refresh LRU position
  store.set(key, e);
  return e.value;
}

export function cacheSet(key: string, value: CachedChat): void {
  store.delete(key);
  store.set(key, { value, expires: Date.now() + config.responseCache.ttlMs });
  while (store.size > config.responseCache.maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Cache lookup + in-flight coalescing: identical concurrent requests share one
 * upstream call. Returns the value and how it was obtained.
 */
export async function cacheGetOrCompute(
  key: string,
  compute: () => Promise<CachedChat>,
): Promise<{ value: CachedChat; status: "HIT" | "MISS" | "COALESCED" }> {
  const hit = cacheGet(key);
  if (hit) {
    incrementCounter("1min_bridge_response_cache_total", { result: "hit" });
    return { value: hit, status: "HIT" };
  }
  const pending = inflight.get(key);
  if (pending) {
    incrementCounter("1min_bridge_response_cache_total", { result: "coalesced" });
    return { value: await pending, status: "COALESCED" };
  }
  incrementCounter("1min_bridge_response_cache_total", { result: "miss" });
  const p = compute();
  inflight.set(key, p);
  try {
    const value = await p;
    cacheSet(key, value);
    return { value, status: "MISS" };
  } finally {
    inflight.delete(key);
  }
}

export function cacheSize(): number {
  return store.size;
}

/** Test hook. */
export function _cacheClear(): void {
  store.clear();
  inflight.clear();
}
