// ============================================================================
// 1min-bridge — Model groups / aliases with ordered fallback.
// MODEL_GROUPS="auto-smart=gpt-5|gpt-4.1|deepseek-v4-pro;my-fast=qwen3.7-flash|gpt-4.1-nano"
// Built-in `auto-cheap`: the three cheapest chat models served by the OpenAI
// endpoint (re-evaluated from the live catalog, so it survives model churn).
// A request for a group tries each member in order until one succeeds.
// ============================================================================

import type { Context } from "hono";
import { getCheapestChatModels, getModelData } from "./model-registry.js";
import { breakerOpen, getEndpointModels, requestContext } from "./upstream/core.js";
import { RelayError, invalidRequestError, sendError } from "./errors.js";
import { incrementCounter } from "./metrics.js";
import type { Env } from "./types.js";

const BUILTIN_CHEAP = "auto-cheap";

function staticGroups(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const def of (process.env.MODEL_GROUPS ?? "").split(";")) {
    const [name, members] = def.split("=");
    const list = (members ?? "")
      .split("|")
      .map((m) => m.trim())
      .filter(Boolean);
    if (name?.trim() && list.length > 0) groups.set(name.trim(), list);
  }
  return groups;
}

export function groupNames(): string[] {
  const names = new Set(staticGroups().keys());
  names.add(BUILTIN_CHEAP);
  return [...names];
}

/** Ordered healthy candidates for a group name, or null if `name` is not a group. */
export async function resolveGroup(name: string, apiKey: string): Promise<string[] | null> {
  const groups = staticGroups();
  let members = groups.get(name);
  if (!members) {
    if (name !== BUILTIN_CHEAP) return null;
    const endpoint = await getEndpointModels(apiKey).catch(() => null);
    const ranked = await getCheapestChatModels(20).catch(() => []);
    members = (endpoint ? ranked.filter((m) => endpoint.has(m)) : ranked).slice(0, 3);
  }
  const catalog = new Set((await getModelData()).chatModelIds);
  const known = members.filter((m) => catalog.has(m));
  // Healthy first, but keep tripped models as a last resort.
  return [...known.filter((m) => !breakerOpen(m)), ...known.filter((m) => breakerOpen(m))];
}

function shouldCascade(err: unknown): boolean {
  if (!(err instanceof RelayError)) return true;
  if (err.code === "model_not_found") return true;
  return err.status >= 500 || err.status === 408;
}

function withHeaders(r: Response, extra: Record<string, string>): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

/**
 * Run `handler` for the requested model; when it names a group, try members in
 * order and cascade on upstream failures.
 */
export async function runWithModelGroups(
  c: Context<Env>,
  raw: unknown,
  handler: (c: Context<Env>, raw: unknown) => Promise<Response>,
): Promise<Response> {
  const model = (raw as { model?: unknown } | null)?.model;
  if (typeof model !== "string") return handler(c, raw);
  const base = model.replace(/:(pdf|summarize|code|online)$/, "");
  const suffix = model.slice(base.length);

  const candidates = await resolveGroup(base, c.get("oneMinApiKey"));
  if (!candidates) return handler(c, raw);
  if (candidates.length === 0) {
    return sendError(c, invalidRequestError(`Model group '${base}' has no available models`, "model_not_found"));
  }

  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]!;
    const last = i === candidates.length - 1;
    const store = requestContext.getStore() ?? { priority: 1 };
    try {
      // Non-final members must fail fast so the next member is tried; only the
      // final one may fall back to the legacy endpoint.
      const res = await requestContext.run({ ...store, noLegacyFallback: !last }, () =>
        handler(c, { ...(raw as object), model: cand + suffix }),
      );
      incrementCounter("1min_bridge_model_group_total", { group: base, model: cand });
      return withHeaders(res, { "X-Bridge-Model": cand, "X-Bridge-Group": base });
    } catch (err) {
      if (!shouldCascade(err)) throw err;
      lastErr = err;
      console.warn(`Model group '${base}': ${cand} failed (${(err as Error).message}); trying next`);
    }
  }
  throw lastErr;
}
