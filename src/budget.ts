// ============================================================================
// 1min-bridge — Per-client daily credit budgets (estimated credits, UTC day)
// Client = `X-Bridge-Client` header (e.g. "litellm", "pi"), else "default".
// CLIENT_BUDGETS="litellm=500000,pi=200000"; DAILY_CREDIT_BUDGET applies to
// clients without an explicit entry. 0 / unset = unlimited.
// ============================================================================

import { RelayError } from "./errors.js";
import { incrementCounter } from "./metrics.js";

interface Spend {
  day: string;
  credits: number;
}

const spend = new Map<string, Spend>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseBudgets(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? "").split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    const n = Number(v);
    if (k && Number.isFinite(n) && n >= 0) out.set(k, n);
  }
  return out;
}

export function budgetFor(label: string): number {
  const explicit = parseBudgets(process.env.CLIENT_BUDGETS).get(label);
  if (explicit !== undefined) return explicit;
  return Number(process.env.DAILY_CREDIT_BUDGET) || 0;
}

export function clientLabel(header: string | undefined | null): string {
  const v = (header ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  return v.slice(0, 40) || "default";
}

function current(label: string): Spend {
  const s = spend.get(label);
  if (!s || s.day !== today()) {
    const fresh = { day: today(), credits: 0 };
    spend.set(label, fresh);
    return fresh;
  }
  return s;
}

/** Throws 429 `budget_exceeded` when the client has used its daily budget. */
export function checkBudget(label: string): void {
  const budget = budgetFor(label);
  if (budget <= 0) return;
  if (current(label).credits >= budget) {
    incrementCounter("1min_bridge_budget_rejected_total", { client: label });
    throw new RelayError(
      `Daily credit budget exhausted for client '${label}' (${budget.toLocaleString()} est. credits). Resets at 00:00 UTC.`,
      429,
      "rate_limit_exceeded",
      "budget_exceeded",
    );
  }
}

export function addSpend(label: string, credits: number): void {
  if (credits > 0) current(label).credits += credits;
}

export function getBudgetStatus(): { client: string; spent: number; budget: number }[] {
  return [...spend.entries()].map(([client, s]) => ({
    client,
    spent: Math.round(s.credits),
    budget: budgetFor(client),
  }));
}

/** Test hook. */
export function _resetBudgets(): void {
  spend.clear();
}
