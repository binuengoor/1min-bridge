// ============================================================================
// 1min-bridge — Integration tests against a fake 1min.ai upstream.
// Exercises routing, streaming, native tools, cache, retries, breaker, limiter,
// Anthropic route and fallbacks without touching the real service.
// ============================================================================

import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";

interface Seen {
  path: string;
  auth: string | undefined;
  body: any;
}
const seen: Seen[] = [];
const openaiHits = () => seen.filter((s) => s.path === "/openai/v1/chat/completions");
const legacyHits = () => seen.filter((s) => s.path.startsWith("/api/chat-with-ai"));
let flaky429Left = 1;

const ENDPOINT_MODELS = ["fast-model", "flaky-model", "stall-model", "gpt-5-test", "other-model"];
const LEGACY_ONLY_MODELS = ["legacy-model"];

function modelEntry(id: string) {
  return {
    uuid: id,
    modelId: id,
    name: id,
    group: "chat",
    provider: "test",
    status: "ACTIVE",
    features: ["UNIFY_CHAT_WITH_AI"],
    creditMetadata: { INPUT: 1, OUTPUT: 1 },
    modality: null,
  };
}

function lastUser(body: any): string {
  const msgs = (body.messages ?? []) as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return String(msgs[i].content);
  }
  return "";
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const body = req.method === "POST" ? await readBody(req) : {};
  seen.push({ path: url.pathname, auth: req.headers.authorization, body });

  const json = (status: number, obj: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/models") {
    const feature = url.searchParams.get("feature");
    const models =
      feature === "UNIFY_CHAT_WITH_AI"
        ? [...ENDPOINT_MODELS, ...LEGACY_ONLY_MODELS].map(modelEntry)
        : [];
    return json(200, { models, total: models.length });
  }
  if (url.pathname === "/openai/v1/models") {
    return json(200, { object: "list", data: ENDPOINT_MODELS.map((id) => ({ id, object: "model" })) });
  }
  if (url.pathname === "/api/chat-with-ai") {
    return json(200, {
      aiRecord: {
        aiRecordDetail: { resultObject: [`legacy: ${body.promptObject?.prompt?.slice(-20) ?? ""}`] },
        metadata: { credit: 50 },
        teamUser: { usedCredit: 1000, creditLimit: 100000 },
      },
    });
  }
  if (url.pathname !== "/openai/v1/chat/completions") return json(404, { error: { message: "nf" } });

  const user = lastUser(body);
  const model = body.model as string;
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 7,
    total_tokens: 107,
    prompt_tokens_details: { cached_tokens: 64 },
  };

  if (user.includes("FAIL429") && flaky429Left > 0) {
    flaky429Left--;
    res.writeHead(429, { "Content-Type": "application/json", "retry-after": "0" });
    return res.end(JSON.stringify({ error: { message: "slow down" } }));
  }
  if (model === "flaky-model") return json(500, { error: { message: "boom" } });

  const wantsTool = Array.isArray(body.tools) && body.tools.length > 0 && user.includes("weather");
  const content = user.includes("JSONFENCE") ? "```json\n{\"x\":1}\n```" : `echo: ${user}`;

  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id: "up-1", object: "chat.completion.chunk", model };
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    if (model === "stall-model") return; // go silent
    if (wantsTool) {
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_up", type: "function", function: { name: "get_weather", arguments: "" } }] } }] });
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] });
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Rome"}' } }] } }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { content: "<think>hidden</think>" } }] });
      for (const part of content.match(/.{1,6}/g) ?? [""]) {
        send({ ...base, choices: [{ index: 0, delta: { content: part } }] });
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    send({ ...base, choices: [], usage });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  const message = wantsTool
    ? { role: "assistant", content: null, tool_calls: [{ id: "call_up", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }] }
    : { role: "assistant", content };
  return json(200, {
    id: "up-1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: wantsTool ? "tool_calls" : "stop" }],
    usage,
  });
});

async function main() {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    ONE_MIN_API_KEY: "test-key",
    ONE_MIN_OPENAI_CHAT_URL: `${base}/openai/v1/chat/completions`,
    ONE_MIN_CHAT_API_URL: `${base}/api/chat-with-ai`,
    ONE_MIN_CHAT_STREAMING_URL: `${base}/api/chat-with-ai?isStreaming=true`,
    ONE_MIN_MODELS_URL: `${base}/models`,
    ONE_MIN_UPSTREAM_RPM: "1000",
    ONE_MIN_UPSTREAM_RETRIES: "1",
    MODEL_GROUPS: "test-group=flaky-model|fast-model;dead-group=flaky-model|flaky-model",
    CLIENT_BUDGETS: "tiny=100",
    CHECKIN_ENABLED: "false",
    LOG_LEVEL: "error",
  });
  const { default: app } = await import("../src/index.js");
  const { config } = await import("../src/config.js");
  const core = await import("../src/upstream/core.js");
  const cache = await import("../src/cache/response-cache.js");

  const H = { "Content-Type": "application/json" };
  const chat = (body: object, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { ...H, ...headers },
        body: JSON.stringify(body),
      }),
    );
  const messagesApi = (body: object) =>
    app.fetch(new Request("http://localhost/v1/messages", { method: "POST", headers: H, body: JSON.stringify(body) }));
  const sseData = async (res: Response) =>
    (await res.text())
      .split("\n\n")
      .map((b) => b.trim())
      .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
      .map((b) => JSON.parse(b.slice(6)));
  const weatherTool = [
    { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } },
  ];
  let n = 0;
  const step = (name: string) => console.log(`  ${++n}. ${name}`);

  console.log("🔌 Integration tests (fake upstream)\n");

  step("plain completion routes natively with real usage + default key");
  let res = await chat({ model: "fast-model", messages: [{ role: "user", content: "hello" }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("x-bridge-route"), "openai");
  let j: any = await res.json();
  assert.strictEqual(j.choices[0].message.content, "echo: hello");
  assert.strictEqual(j.usage.prompt_tokens, 100);
  assert.strictEqual(openaiHits().at(-1)!.auth, "Bearer test-key");

  step("streaming forwards deltas, strips <think>, emits usage chunk");
  res = await chat({ model: "fast-model", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "stream me" }] });
  const chunks = await sseData(res);
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  assert.strictEqual(text, "echo: stream me");
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "stop"));
  assert.strictEqual(chunks.at(-1).usage.prompt_tokens, 100);

  step("native tool calls (non-stream and stream)");
  const toolReq = { model: "fast-model", tools: weatherTool, messages: [{ role: "user", content: "weather in Rome" }] };
  j = await (await chat(toolReq)).json();
  assert.strictEqual(j.choices[0].finish_reason, "tool_calls");
  assert.strictEqual(j.choices[0].message.tool_calls[0].function.name, "get_weather");
  assert.ok(openaiHits().at(-1)!.body.tools, "tools forwarded natively, not emulated");
  const tchunks = await sseData(await chat({ ...toolReq, stream: true }));
  const args = tchunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? "").join("");
  assert.strictEqual(args, '{"city":"Rome"}');
  assert.strictEqual(tchunks.at(-1).choices[0].finish_reason, "tool_calls");

  step("response cache: temp 0 hits, other temps and bypass do not");
  cache._cacheClear();
  const det = { model: "fast-model", temperature: 0, messages: [{ role: "user", content: "cache me" }] };
  const before = openaiHits().length;
  res = await chat(det);
  assert.strictEqual(res.headers.get("x-bridge-cache"), "MISS");
  res = await chat(det);
  assert.strictEqual(res.headers.get("x-bridge-cache"), "HIT");
  assert.strictEqual(openaiHits().length, before + 1, "hit made no upstream call");
  res = await chat({ ...det, stream: true });
  assert.strictEqual(res.headers.get("x-bridge-cache"), "HIT");
  assert.strictEqual((await sseData(res)).map((c) => c.choices?.[0]?.delta?.content ?? "").join(""), "echo: cache me");
  res = await chat(det, { "X-Bridge-Cache": "bypass" });
  assert.strictEqual(res.headers.get("x-bridge-cache"), null);
  res = await chat({ ...det, temperature: 0.7 });
  assert.strictEqual(res.headers.get("x-bridge-cache"), null);
  res = await chat({ ...det, temperature: 0.7 }, { "X-Bridge-Cache": "on" });
  assert.strictEqual(res.headers.get("x-bridge-cache"), "MISS");

  step("identical parallel requests coalesce into one upstream call");
  cache._cacheClear();
  const b2 = openaiHits().length;
  const par = await Promise.all(
    [1, 2, 3, 4].map(() => chat({ model: "fast-model", temperature: 0, messages: [{ role: "user", content: "parallel" }] })),
  );
  assert.strictEqual(openaiHits().length, b2 + 1);
  assert.deepStrictEqual(par.map((r) => r.headers.get("x-bridge-cache")).sort(), ["COALESCED", "COALESCED", "COALESCED", "MISS"]);

  step("429 from upstream is retried transparently");
  flaky429Left = 1;
  const b3 = openaiHits().length;
  res = await chat({ model: "fast-model", messages: [{ role: "user", content: "FAIL429 please" }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(openaiHits().length, b3 + 2);

  step("model off the endpoint list uses legacy; :online forces legacy");
  res = await chat({ model: "legacy-model", messages: [{ role: "user", content: "hi there" }] });
  assert.strictEqual(res.headers.get("x-bridge-route"), "legacy");
  assert.ok(((await res.json()) as any).choices[0].message.content.startsWith("legacy:"));
  res = await chat({ model: "fast-model:online", messages: [{ role: "user", content: "news" }] });
  assert.strictEqual(res.headers.get("x-bridge-route"), "legacy");

  step("failing upstream falls back to legacy and opens the circuit breaker");
  for (let i = 0; i < 3; i++) {
    res = await chat({ model: "flaky-model", messages: [{ role: "user", content: `try ${i}` }] });
    assert.strictEqual(res.status, 200, "fallback answers instead of erroring");
    assert.ok(((await res.json()) as any).choices[0].message.content.startsWith("legacy:"));
  }
  assert.ok(core.breakerOpen("flaky-model"));
  const b4 = openaiHits().length;
  await chat({ model: "flaky-model", messages: [{ role: "user", content: "after breaker" }] });
  assert.strictEqual(openaiHits().length, b4, "open breaker skips the endpoint");
  core.recordUpstreamSuccess("flaky-model");

  step("json_object: leading system instruction + fence stripping");
  res = await chat({ model: "fast-model", response_format: { type: "json_object" }, messages: [{ role: "user", content: "JSONFENCE" }] });
  j = await res.json();
  assert.strictEqual(j.choices[0].message.content, '{"x":1}');
  assert.strictEqual(openaiHits().at(-1)!.body.messages[0].role, "system");
  assert.ok(!("response_format" in openaiHits().at(-1)!.body), "json_object is never sent upstream");

  step("json_schema is forwarded upstream");
  await chat({ model: "fast-model", response_format: { type: "json_schema", json_schema: { name: "a", schema: {} } }, messages: [{ role: "user", content: "schema" }] });
  assert.strictEqual(openaiHits().at(-1)!.body.response_format.type, "json_schema");

  step("Anthropic /v1/messages: text, tool_use and streamed input_json_delta");
  j = await (await messagesApi({ model: "fast-model", max_tokens: 50, messages: [{ role: "user", content: "hey" }] })).json();
  assert.strictEqual(j.content[0].text, "echo: hey");
  assert.strictEqual(j.usage.input_tokens, 100);
  const aTool = { name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } };
  j = await (await messagesApi({ model: "fast-model", max_tokens: 50, tools: [aTool], messages: [{ role: "user", content: "weather" }] })).json();
  assert.strictEqual(j.stop_reason, "tool_use");
  assert.deepStrictEqual(j.content[0].input, { city: "Rome" });
  const raw = await (await messagesApi({ model: "fast-model", stream: true, max_tokens: 50, tools: [aTool], messages: [{ role: "user", content: "weather" }] })).text();
  assert.ok(raw.includes("event: content_block_start") && raw.includes("input_json_delta") && raw.includes('"stop_reason":"tool_use"'));

  step("stalled upstream stream is aborted by the idle timeout");
  const oldIdle = config.streamIdleMs;
  config.streamIdleMs = 300;
  res = await chat({ model: "stall-model", stream: true, messages: [{ role: "user", content: "stall" }] });
  const t0 = Date.now();
  let errored = false;
  try {
    await res.text();
  } catch {
    errored = true;
  }
  assert.ok(errored && Date.now() - t0 < 5000, "stream errors out instead of hanging");
  config.streamIdleMs = oldIdle;

  step("upstream rate limiter queues, then rejects with 429 beyond the wait budget");
  const saved = { rpm: config.upstreamRpm, wait: config.upstreamMaxWaitMs };
  config.upstreamRpm = 3;
  config.upstreamMaxWaitMs = 150;
  await core.acquireSlot("limiter-key");
  await core.acquireSlot("limiter-key");
  await core.acquireSlot("limiter-key");
  await assert.rejects(core.acquireSlot("limiter-key"), (e: any) => e.status === 429);
  await core.acquireSlot("other-key"); // keys are limited independently
  config.upstreamRpm = saved.rpm;
  config.upstreamMaxWaitMs = saved.wait;

  step("model group cascades to the next member instead of the legacy API");
  core.recordUpstreamSuccess("flaky-model");
  const legacyBefore = legacyHits().length;
  res = await chat({ model: "test-group", messages: [{ role: "user", content: "group please" }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("x-bridge-model"), "fast-model");
  assert.strictEqual(res.headers.get("x-bridge-group"), "test-group");
  j = await res.json();
  assert.strictEqual(j.model, "fast-model");
  assert.strictEqual(j.choices[0].message.content, "echo: group please");
  assert.strictEqual(legacyHits().length, legacyBefore, "no legacy call while a healthy member exists");
  res = await chat({ model: "test-group", stream: true, messages: [{ role: "user", content: "group stream" }] });
  assert.strictEqual(res.headers.get("x-bridge-model"), "fast-model");
  assert.ok((await res.text()).includes("echo: "));
  core.recordUpstreamSuccess("flaky-model");

  step("last group member may use legacy fallback; groups are listed in /v1/models");
  core.recordUpstreamSuccess("flaky-model");
  res = await chat({ model: "dead-group", messages: [{ role: "user", content: "all dead" }] });
  assert.strictEqual(res.status, 200);
  assert.ok(((await res.json()) as any).choices[0].message.content.startsWith("legacy:"));
  const listed: any = await (await app.fetch(new Request("http://localhost/v1/models"))).json();
  const ids = listed.data.map((m: any) => m.id);
  assert.ok(ids.includes("auto-cheap") && ids.includes("test-group"));
  core.recordUpstreamSuccess("flaky-model");

  step("credit header, per-client budget and savings accounting");
  res = await chat({ model: "fast-model", messages: [{ role: "user", content: "credits" }] }, { "X-Bridge-Client": "tiny" });
  assert.strictEqual(res.status, 200);
  assert.ok(Number(res.headers.get("x-bridge-credits")) > 0, "credit estimate header present");
  res = await chat({ model: "fast-model", messages: [{ role: "user", content: "credits 2" }] }, { "X-Bridge-Client": "tiny" });
  assert.strictEqual(res.status, 429);
  assert.strictEqual(((await res.json()) as any).error.code, "budget_exceeded");
  res = await chat({ model: "fast-model", messages: [{ role: "user", content: "other client" }] }, { "X-Bridge-Client": "free" });
  assert.strictEqual(res.status, 200, "other clients are unaffected");
  cache._cacheClear();
  await chat(det);
  res = await chat(det);
  assert.strictEqual(res.headers.get("x-bridge-credits"), "0", "cache hits are free");
  const stats: any = await (await app.fetch(new Request("http://localhost/api/stats"))).json();
  assert.ok(stats.totalCreditsSaved > 0 && stats.cacheHits > 0, "savings are tracked");

  step("reasoning_effort only reaches models that accept it");
  await chat({ model: "gpt-5-test", reasoning_effort: "low", messages: [{ role: "user", content: "think" }] });
  assert.strictEqual(openaiHits().at(-1)!.body.reasoning_effort, "low");
  await chat({ model: "fast-model", reasoning_effort: "low", messages: [{ role: "user", content: "think 2" }] });
  assert.ok(!("reasoning_effort" in openaiHits().at(-1)!.body));

  step("limiter serves high priority before low once a slot frees up");
  const keep = { rpm: config.upstreamRpm, win: config.upstreamWindowMs, wait: config.upstreamMaxWaitMs };
  config.upstreamRpm = 1;
  config.upstreamWindowMs = 300;
  config.upstreamMaxWaitMs = 3000;
  await core.acquireSlot("prio-key");
  const order: string[] = [];
  const low = core.requestContext.run({ priority: 0 }, () => core.acquireSlot("prio-key").then(() => order.push("low")));
  const high = core.requestContext.run({ priority: 2 }, () => core.acquireSlot("prio-key").then(() => order.push("high")));
  await Promise.all([low, high]);
  assert.deepStrictEqual(order, ["high", "low"]);
  config.upstreamRpm = keep.rpm;
  config.upstreamWindowMs = keep.win;
  config.upstreamMaxWaitMs = keep.wait;

  console.log("\n🎉 ALL INTEGRATION TESTS PASSED\n");
  upstream.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Integration test failed:", err);
  process.exit(1);
});
