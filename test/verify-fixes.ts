// ============================================================================
// 1min-bridge Comprehensive Verification Test Suite
// ============================================================================

import assert from "node:assert";
import { rateLimitMiddleware } from "../src/middleware/rate-limit.js";
import { ToolCallingEmulator } from "../src/adapters/tool-emulator.js";
import { ResponseSanitizer } from "../src/adapters/sanitizer.js";
import { calculateTokens, extractAllChatMessageText } from "../src/utils/tokens.js";
import { getModelData, isValidModel, isVisionModel, isImageModel } from "../src/model-registry.js";
import { incrementCounter, observeHistogram, getMetricsText } from "../src/metrics.js";

async function runTests() {
  console.log("🚀 Starting 1min-bridge verification tests...\n");

  // --------------------------------------------------------------------------
  // Test 1: Rate Limiter Token Bucket Accumulator
  // --------------------------------------------------------------------------
  console.log("Test 1: Rate Limiter Refill & Rapid-fire Token Bucket...");
  const rl = rateLimitMiddleware({ maxRequests: 5, windowMs: 1000, keyFn: () => "test-user" });

  const mockContext = {
    get: () => "test-key",
    req: { header: () => undefined },
    header: () => {},
    json: (data: any, status: number) => new Response(JSON.stringify(data), { status }),
  } as any;

  let passedRequests = 0;
  for (let i = 0; i < 5; i++) {
    let nextCalled = false;
    await rl(mockContext, async () => { nextCalled = true; });
    if (nextCalled) passedRequests++;
  }
  assert.strictEqual(passedRequests, 5, "Initial 5 requests should pass");

  let nextCalled6 = false;
  const res6 = await rl(mockContext, async () => { nextCalled6 = true; });
  assert.strictEqual(nextCalled6, false, "6th request without delay should be rate limited");
  assert.ok(res6, "Should return rate limit response");

  await new Promise((resolve) => setTimeout(resolve, 250));
  let nextCalledAfterRefill = false;
  await rl(mockContext, async () => { nextCalledAfterRefill = true; });
  assert.strictEqual(nextCalledAfterRefill, true, "Token bucket should refill after elapsed interval");
  console.log("  ✅ Rate limiter token refill logic verified successfully.\n");

  // --------------------------------------------------------------------------
  // Test 2: Tool Calling Emulator & Balanced JSON Parsing
  // --------------------------------------------------------------------------
  console.log("Test 2: Tool Calling Emulator & Balanced JSON Parser...");

  const toolDefs = [
    {
      name: "get_weather",
      description: "Gets current weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];

  // Tool injection
  const injectedPrompt = ToolCallingEmulator.injectToolsPrompt("System instructions", toolDefs);
  assert.ok(injectedPrompt.includes("get_weather"), "Prompt should include tool name");
  assert.ok(injectedPrompt.includes("TOOL CALLING EXECUTION SYSTEM"), "Prompt should have tool instructions");

  // DeepSeek-R1 <think> stripping + balanced JSON parsing
  const rawModelResponse = `<think>
I need to check the weather for New York. Let me call get_weather.
</think>
\`\`\`json
{
  "tool_calls": [
    {
      "id": "call_12345",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": { "city": "New York", "unit": "celsius" }
      }
    }
  ]
}
\`\`\``;

  const parsedCalls = ToolCallingEmulator.parseResponse(rawModelResponse, toolDefs);
  assert.ok(parsedCalls, "Should extract tool calls");
  assert.strictEqual(parsedCalls.length, 1);
  assert.strictEqual(parsedCalls[0]!.function.name, "get_weather");
  assert.ok(parsedCalls[0]!.function.arguments.includes("New York"));

  // Standalone JSON block with nested braces
  const nestedJsonResponse = `Sure, calling the tool now: {"function": {"name": "get_weather", "arguments": {"city": "São Paulo", "details": {"source": "station_1"}}}}`;
  const parsedNested = ToolCallingEmulator.parseResponse(nestedJsonResponse, toolDefs);
  assert.ok(parsedNested, "Should extract nested tool call from arbitrary text");
  assert.strictEqual(parsedNested.length, 1);
  assert.strictEqual(parsedNested[0]!.function.name, "get_weather");

  console.log("  ✅ ToolCallingEmulator and balanced JSON parsing verified.\n");

  // --------------------------------------------------------------------------
  // Test 3: ResponseSanitizer Anti-Leak & Memory Unpacker
  // --------------------------------------------------------------------------
  console.log("Test 3: ResponseSanitizer & RAG Memory Unpacker...");

  // Sanitizer cleanup
  const dirtyOutput = `<think>Internal thinking...</think>
Assistant: The current weather in New York is sunny and 22°C.
Tool: [{"result": "ok"}]`;
  const cleanOutput = ResponseSanitizer.cleanOutput(dirtyOutput);
  assert.strictEqual(cleanOutput, "The current weather in New York is sunny and 22°C.");

  // Memory unpacker
  const langchainDoc = {
    pageContent: "Revenue grew 25% year-over-year.",
    metadata: { timestamp: "2026-08-15" },
  };
  const unpackedDoc = ResponseSanitizer.unpackMemoryContent(langchainDoc);
  assert.ok(unpackedDoc.includes("Revenue grew 25%"));
  assert.ok(unpackedDoc.includes("2026-08-15"));

  console.log("  ✅ ResponseSanitizer and RAG memory unrolling verified.\n");

  // --------------------------------------------------------------------------
  // Test 4: Accurate Token Counting with gpt-tokenizer
  // --------------------------------------------------------------------------
  console.log("Test 4: Token Estimation & BPE Tokens...");
  const sampleText = "Hello, world! Welcome to the 1min universal gateway.";
  const tokenCount = calculateTokens(sampleText);
  assert.ok(tokenCount > 0 && tokenCount < 20, `Token count ${tokenCount} should be realistic`);

  const sampleMessages = [
    { role: "user" as const, content: "What is 2 + 2?" },
    { role: "assistant" as const, content: "2 + 2 = 4." },
  ];
  const allText = extractAllChatMessageText(sampleMessages);
  assert.strictEqual(allText, "What is 2 + 2? 2 + 2 = 4.");
  console.log("  ✅ Accurate token calculations verified.\n");

  // --------------------------------------------------------------------------
  // Test 5: Model Registry Lookups
  // --------------------------------------------------------------------------
  console.log("Test 5: Model Registry & Fast Lookups...");
  const modelData = await getModelData();
  assert.ok(modelData.entries.length > 0, "Model registry should have entries");

  const isGpt4oValid = await isValidModel("gpt-4o");
  assert.strictEqual(isGpt4oValid, true, "gpt-4o should be valid");

  const isGpt4oVision = await isVisionModel("gpt-4o");
  assert.strictEqual(isGpt4oVision, true, "gpt-4o should be vision model");

  const isSampleImage = await isImageModel(modelData.imageModelIds[0]!);
  assert.strictEqual(isSampleImage, true, "image model check should be true");

  console.log("  ✅ Model registry lookups and caching verified.\n");

  // --------------------------------------------------------------------------
  // Test 6: Prometheus Metrics
  // --------------------------------------------------------------------------
  console.log("Test 6: Prometheus Metrics...");
  incrementCounter("test_counter_total", { method: "POST", path: "/v1/chat/completions", status: "200" });
  observeHistogram("test_duration_seconds", { method: "POST", path: "/v1/chat/completions" }, 0.125);
  const metricsOutput = getMetricsText();
  assert.ok(metricsOutput.includes("test_counter_total"));
  assert.ok(metricsOutput.includes("test_duration_seconds"));
  console.log("  ✅ Prometheus metrics collection verified.\n");

  // --------------------------------------------------------------------------
  // Test 7: HTTP Routing & Protocol Endpoints
  // --------------------------------------------------------------------------
  console.log("Test 7: HTTP Endpoints & Authentication...");
  const { default: app } = await import("../src/index.js");

  // Health check
  const healthRes = await app.fetch(new Request("http://localhost:3000/health"));
  assert.strictEqual(healthRes.status, 200);

  // 404
  const notFoundRes = await app.fetch(new Request("http://localhost:3000/nonexistent_route"));
  assert.strictEqual(notFoundRes.status, 404);

  // Protected OpenAI Chat Completions without auth -> 401
  const unauthChat = await app.fetch(
    new Request("http://localhost:3000/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  assert.strictEqual(unauthChat.status, 401);

  // Protected Anthropic Messages without auth -> 401
  const unauthMessages = await app.fetch(
    new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-sonnet", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  assert.strictEqual(unauthMessages.status, 401);

  // Protected Responses API without auth -> 401
  const unauthResponses = await app.fetch(
    new Request("http://localhost:3000/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "test" }),
    }),
  );
  assert.strictEqual(unauthResponses.status, 401);

  // Anthropic authentication via x-api-key header
  const authWithXApiKey = await app.fetch(
    new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-mock-key",
      },
      body: JSON.stringify({
        model: "gpt-4o", // using valid mock model
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  );
  // It shouldn't be 401 Unauthorized since x-api-key was provided
  assert.notStrictEqual(authWithXApiKey.status, 401, "x-api-key authentication should be recognized");

  console.log("  ✅ Protocol routes and multi-auth headers verified.\n");

  // --------------------------------------------------------------------------
  // Test 8: RFC 6238 TOTP Generator & Base32 Decoding
  // --------------------------------------------------------------------------
  console.log("Test 8: RFC 6238 TOTP Generator & Base32 Decoding...");
  const { base32Decode, generateTotp } = await import("../src/checkin/totp.js");
  const decoded = base32Decode("MZXW6YTBOI======").toString("utf-8");
  assert.strictEqual(decoded, "foobar");

  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const otp = generateTotp(rfcSecret, { timestamp: 59 * 1000, digits: 6, period: 30 });
  assert.strictEqual(otp, "287082");
  console.log("  ✅ Zero-dependency RFC 6238 TOTP generator verified.\n");

  // --------------------------------------------------------------------------
  // Test 9: Direct-API Checkin Status Endpoints
  // --------------------------------------------------------------------------
  console.log("Test 9: Check-in Status Endpoints & Health...");
  const statusRes = await app.fetch(new Request("http://localhost:3000/v1/checkin/status"));
  assert.strictEqual(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.strictEqual(typeof statusData.enabled, "boolean");
  assert.ok(Array.isArray(statusData.history));

  const aliasStatusRes = await app.fetch(new Request("http://localhost:3000/api/checkin/status"));
  assert.strictEqual(aliasStatusRes.status, 200);
  console.log("  ✅ Check-in status endpoints verified.\n");

  // --------------------------------------------------------------------------
  // Test 10: Credit Calculations, Stats API & Web Dashboard
  // --------------------------------------------------------------------------
  console.log("Test 10: Credit Calculations & Web Dashboard...");
  const { calculateCredits } = await import("../src/utils/credits.js");
  const { statsTracker } = await import("../src/stats.js");

  const estCredits = await calculateCredits("gpt-4o", 500, 200);
  assert.ok(estCredits > 0, "Calculated credits should be positive");

  statsTracker.recordRequest({
    method: "POST",
    path: "/v1/chat/completions",
    model: "gpt-4o",
    status: 200,
    durationMs: 250,
    credits: estCredits,
  });

  const apiStatsRes = await app.fetch(new Request("http://localhost:3000/api/stats"));
  assert.strictEqual(apiStatsRes.status, 200);
  const statsPayload = await apiStatsRes.json();
  assert.ok(statsPayload.totalRequests > 0);

  const dashHtmlRes = await app.fetch(new Request("http://localhost:3000/dashboard"));
  assert.strictEqual(dashHtmlRes.status, 200);
  const dashHtml = await dashHtmlRes.text();
  assert.ok(dashHtml.includes("1min-bridge Live Dashboard"));
  assert.ok(dashHtml.includes("tab-credits"));
  console.log("  ✅ Credit calculations and live Web Dashboard verified.\n");

  console.log("🎉 ALL VERIFICATION TESTS PASSED SUCCESSFULLY!\n");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
