// ============================================================================
// Tests for StatsTracker, Credit Calculations, and Dashboard Routes
// ============================================================================

import assert from "node:assert";
import { statsTracker } from "../src/stats.js";
import { calculateCredits } from "../src/utils/credits.js";
import app from "../src/index.js";

console.log("Running Stats & Credit Analytics unit tests...");

async function runStatsTests() {
  // 1. Test Credit Calculation
  {
    const chatCredits = await calculateCredits("gpt-4o", 1000, 500, "chat");
    assert.ok(chatCredits > 0, "Chat credits should be greater than 0");

    const imageCredits = await calculateCredits("flux-schnell", 0, 0, "image");
    assert.ok(imageCredits >= 50, `Image credits should be at least 50, got ${imageCredits}`);

    const speechCredits = await calculateCredits("whisper-1", 0, 0, "speech");
    assert.ok(speechCredits > 0, "Speech credits should be positive");

    console.log("  ✓ Credit calculation utility verified");
  }

  // 2. Test StatsTracker Recording
  {
    statsTracker.recordRequest({
      method: "POST",
      path: "/v1/chat/completions",
      model: "gpt-4o",
      status: 200,
      durationMs: 350,
      promptTokens: 100,
      completionTokens: 50,
      credits: 12.5,
    });

    statsTracker.recordRequest({
      method: "POST",
      path: "/v1/messages",
      model: "claude-3-5-sonnet",
      status: 200,
      durationMs: 420,
      promptTokens: 200,
      completionTokens: 80,
      credits: 22.0,
    });

    const summary = statsTracker.getSummary();
    assert.ok(summary.totalRequests >= 2, "Total requests should be at least 2");
    assert.ok(summary.totalCreditsConsumed >= 34.5, "Total credits consumed should be at least 34.5");

    // Check models aggregation
    const gptModel = summary.models.find((m) => m.model === "gpt-4o");
    assert.ok(gptModel, "gpt-4o should be recorded in models");
    assert.ok(gptModel.credits >= 12.5, "gpt-4o credits should be recorded");

    const claudeModel = summary.models.find((m) => m.model === "claude-3-5-sonnet");
    assert.ok(claudeModel, "claude-3-5-sonnet should be recorded");
    assert.ok(claudeModel.credits >= 22.0, "claude credits should be recorded");

    // Check endpoints aggregation
    const chatEndpoint = summary.endpoints.find((e) => e.path === "/v1/chat/completions");
    assert.ok(chatEndpoint, "/v1/chat/completions endpoint should be recorded");

    // Check recent requests
    assert.ok(summary.recentRequests.length >= 2, "Recent requests should contain entries");
    assert.strictEqual(summary.recentRequests[0]?.model, "claude-3-5-sonnet");

    console.log("  ✓ StatsTracker aggregation & ring buffer verified");
  }

  // 3. Test GET /api/stats JSON API Route
  {
    const res = await app.fetch(new Request("http://localhost:3000/api/stats"));
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.totalRequests, "number");
    assert.strictEqual(typeof data.totalCreditsConsumed, "number");
    assert.ok(Array.isArray(data.models));
    assert.ok(Array.isArray(data.endpoints));
    assert.ok(Array.isArray(data.recentRequests));
    assert.ok(data.checkin);
    console.log("  ✓ GET /api/stats endpoint returned complete schema");
  }

  // 4. Test GET /dashboard and GET /stats HTML Web UI Routes
  {
    const dashRes = await app.fetch(new Request("http://localhost:3000/dashboard"));
    assert.strictEqual(dashRes.status, 200);
    const html = await dashRes.text();
    assert.ok(html.includes("1min-bridge Live Dashboard"));
    assert.ok(html.includes("tab-requests"));
    assert.ok(html.includes("tab-credits"));
    assert.ok(html.includes("checkin-history-table"));

    const statsRes = await app.fetch(new Request("http://localhost:3000/stats"));
    assert.strictEqual(statsRes.status, 200);
    console.log("  ✓ GET /dashboard and /stats rendered responsive web UI");
  }

  console.log("All Stats and Dashboard tests passed successfully!\n");
}

runStatsTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
