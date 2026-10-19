// ============================================================================
// 1min-bridge — Upstream core: endpoint model list, per-key rate limiter,
// retry with jittered backoff, per-model circuit breaker.
// ============================================================================

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";
import { RelayError, upstreamError } from "../errors.js";
import { incrementCounter } from "../metrics.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function keyId(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Endpoint model list (stale-while-revalidate)
// ---------------------------------------------------------------------------

const MODELS_TTL_MS = 30 * 60 * 1000;
let modelSet: Set<string> | null = null;
let modelsExpiry = 0;
let modelsInflight: Promise<void> | null = null;

function modelsUrl(): string {
  return config.oneMinOpenAiChatUrl.replace(/\/chat\/completions\/?$/, "/models");
}

async function refreshModels(apiKey: string): Promise<void> {
  if (modelsInflight) return modelsInflight;
  modelsInflight = (async () => {
    try {
      const res = await fetch(modelsUrl(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data?: { id?: string }[] };
      const ids = (data.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) {
        modelSet = new Set(ids);
        modelsExpiry = Date.now() + MODELS_TTL_MS;
      }
    } catch (err) {
      console.warn("OpenAI endpoint model list refresh failed:", (err as Error).message);
      modelsExpiry = Date.now() + 60_000; // retry in a minute, keep stale list
    } finally {
      modelsInflight = null;
    }
  })();
  return modelsInflight;
}

/** Models served by the OpenAI endpoint, or null when not yet known. */
export async function getEndpointModels(apiKey: string): Promise<Set<string> | null> {
  if (!modelSet) {
    await refreshModels(apiKey);
  } else if (Date.now() > modelsExpiry) {
    void refreshModels(apiKey); // serve stale, refresh in background
  }
  return modelSet;
}

/** Synchronous peek at the cached endpoint model list (null if unknown). */
export function peekEndpointModels(): Set<string> | null {
  return modelSet;
}

/** Test hook. */
export function _setEndpointModels(models: string[] | null): void {
  modelSet = models ? new Set(models) : null;
  modelsExpiry = Date.now() + MODELS_TTL_MS;
}

// ---------------------------------------------------------------------------
// Circuit breaker (per model)
// ---------------------------------------------------------------------------

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 30_000;
const UNSUPPORTED_MS = 10 * 60_000;
const breaker = new Map<string, { fails: number; openUntil: number }>();

export function breakerOpen(model: string): boolean {
  const b = breaker.get(model);
  return Boolean(b && b.openUntil > Date.now());
}
export function recordUpstreamSuccess(model: string): void {
  breaker.delete(model);
}
export function recordUpstreamFailure(model: string): void {
  const b = breaker.get(model) ?? { fails: 0, openUntil: 0 };
  b.fails++;
  if (b.fails >= BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + BREAKER_OPEN_MS;
    b.fails = 0;
    incrementCounter("1min_bridge_upstream_breaker_open_total", { model });
  }
  breaker.set(model, b);
}
/** Model rejected as missing by the endpoint: stop trying it for a while. */
export function markModelUnsupported(model: string): void {
  breaker.set(model, { fails: 0, openUntil: Date.now() + UNSUPPORTED_MS });
}

// ---------------------------------------------------------------------------
// Per-key sliding-window rate limiter (upstream allows ~60 req / 60 s)
// ---------------------------------------------------------------------------

interface Window {
  stamps: number[];
  blockedUntil: number;
}
const windows = new Map<string, Window>();

/** Per-request context (priority) carried to the limiter without threading args. */
export const requestContext = new AsyncLocalStorage<{ priority: number; noLegacyFallback?: boolean }>();

export function priorityFromHeader(value: string | undefined | null): number {
  const v = (value ?? "").toLowerCase();
  if (v === "high" || v === "interactive") return 2;
  if (v === "low" || v === "batch") return 0;
  return 1;
}

interface Waiter {
  prio: number;
  seq: number;
  resolve: () => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
const queues = new Map<string, Waiter[]>();
const pumps = new Map<string, ReturnType<typeof setTimeout>>();
let waiterSeq = 0;

function tryTake(w: Window): boolean {
  const now = Date.now();
  w.stamps = w.stamps.filter((t) => now - t < config.upstreamWindowMs);
  if (w.blockedUntil > now || w.stamps.length >= config.upstreamRpm) return false;
  w.stamps.push(now);
  return true;
}

function nextSlotDelay(w: Window): number {
  const now = Date.now();
  let wait = Math.max(0, w.blockedUntil - now);
  if (w.stamps.length >= config.upstreamRpm) {
    wait = Math.max(wait, w.stamps[0]! + config.upstreamWindowMs - now + 25);
  }
  return Math.max(wait, 10);
}

function pump(id: string): void {
  pumps.delete(id);
  const q = queues.get(id);
  const w = windows.get(id);
  if (!q || !w) return;
  while (q.length > 0 && tryTake(w)) {
    const next = q.shift()!;
    clearTimeout(next.timer);
    next.resolve();
  }
  if (q.length > 0 && !pumps.has(id)) {
    pumps.set(id, setTimeout(() => pump(id), nextSlotDelay(w)));
  }
}

/**
 * Take one upstream slot for this key (sliding 60 s window). Waiters are served
 * by priority (high > normal > low), then FIFO; a waiter that cannot be served
 * within upstreamMaxWaitMs is rejected with 429.
 */
export function acquireSlot(apiKey: string): Promise<void> {
  const id = keyId(apiKey);
  const w = windows.get(id) ?? { stamps: [], blockedUntil: 0 };
  windows.set(id, w);
  const q = queues.get(id) ?? [];
  queues.set(id, q);
  if (q.length === 0 && tryTake(w)) return Promise.resolve();

  const prio = requestContext.getStore()?.priority ?? 1;
  incrementCounter("1min_bridge_upstream_ratelimit_waits_total", {});
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      prio,
      seq: ++waiterSeq,
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = q.indexOf(waiter);
        if (i >= 0) q.splice(i, 1);
        incrementCounter("1min_bridge_upstream_ratelimit_rejected_total", {});
        reject(
          new RelayError(
            "Upstream rate limit reached (1min.ai allows ~60 requests/minute per key). Retry shortly.",
            429,
            "rate_limit_exceeded",
            "rate_limit_exceeded",
          ),
        );
      }, config.upstreamMaxWaitMs),
    };
    let i = q.length;
    while (i > 0 && q[i - 1]!.prio < prio) i--; // keep higher priority ahead, FIFO within a level
    q.splice(i, 0, waiter);
    if (!pumps.has(id)) pumps.set(id, setTimeout(() => pump(id), nextSlotDelay(w)));
  });
}

function noteRateHeaders(apiKey: string, headers: Headers): void {
  const remaining = Number(headers.get("ratelimit-remaining"));
  const reset = Number(headers.get("ratelimit-reset"));
  if (headers.has("ratelimit-remaining") && remaining <= 0 && reset > 0) {
    const w = windows.get(keyId(apiKey));
    if (w) w.blockedUntil = Math.max(w.blockedUntil, Date.now() + reset * 1000 + 50);
  }
}

// ---------------------------------------------------------------------------
// Retrying fetch for the OpenAI endpoint
// ---------------------------------------------------------------------------

function backoffMs(attempt: number, res?: Response): number {
  const retryAfter = Number(res?.headers.get("retry-after") ?? res?.headers.get("ratelimit-reset"));
  if (retryAfter > 0 && retryAfter <= 30) return retryAfter * 1000 + 50;
  const base = 500 * 2 ** attempt;
  return base * (0.5 + Math.random()); // +/-50% jitter
}

export interface OpenAiFetchOptions {
  stream: boolean;
  totalTimeoutMs?: number;
  headersTimeoutMs?: number;
}

/**
 * POST to the OpenAI endpoint. Acquires a rate-limit slot, retries 429/5xx and
 * network errors with jittered backoff, and throws RelayError otherwise.
 */
export async function openAiFetch(
  apiKey: string,
  payload: unknown,
  opts: OpenAiFetchOptions,
): Promise<Response> {
  const body = JSON.stringify(payload);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.upstreamRetries; attempt++) {
    await acquireSlot(apiKey);
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(),
      opts.stream ? (opts.headersTimeoutMs ?? 60_000) : (opts.totalTimeoutMs ?? 120_000),
    );
    try {
      const res = await fetch(config.oneMinOpenAiChatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: ctl.signal,
      });
      if (opts.stream) clearTimeout(timer); // headers arrived; idle watchdog takes over
      noteRateHeaders(apiKey, res.headers);
      if (res.ok) {
        if (!opts.stream) clearTimeout(timer);
        return res;
      }
      const text = await res.text().catch(() => "");
      clearTimeout(timer);
      const err = upstreamError(res.status, text);
      if ((res.status === 429 || res.status >= 500) && attempt < config.upstreamRetries) {
        incrementCounter("1min_bridge_upstream_retries_total", { status: String(res.status) });
        lastErr = err;
        await sleep(backoffMs(attempt, res));
        continue;
      }
      throw err;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof RelayError) throw err;
      lastErr = err;
      if (attempt < config.upstreamRetries) {
        incrementCounter("1min_bridge_upstream_retries_total", { status: "network" });
        await sleep(backoffMs(attempt));
        continue;
      }
      throw upstreamError(504, (err as Error).message);
    }
  }
  throw lastErr instanceof Error ? lastErr : upstreamError(502, "upstream retries exhausted");
}

/** Abort a stream that goes silent for streamIdleMs. */
export function withIdleTimeout(
  src: ReadableStream<Uint8Array>,
  idleMs = config.streamIdleMs,
): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`upstream stream idle for ${idleMs}ms`)),
          idleMs,
        );
      });
      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        clearTimeout(timer);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
        controller.error(err);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}
