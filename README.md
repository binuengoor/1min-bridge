# 1min-bridge

[![Docker](https://img.shields.io/badge/GHCR-ghcr.io%2Fbinuengoor%2F1min--bridge-blue?logo=docker)](https://github.com/binuengoor/1min-bridge/pkgs/container/1min-bridge)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-API--compatible-green)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/Anthropic-API--compatible-purple)](https://docs.anthropic.com/en/api/messages)

Universal, self-hosted and edge-native AI Gateway for [1min.ai](https://1min.ai) with **automatic model discovery**, dual-runtime support (Node.js/Docker + Cloudflare Workers), full **OpenAI** and **Anthropic Messages** compatibility, and robust ReAct tool-calling emulation.

---

## ✨ Features

- **🧠 Auto Model Discovery** — Polls 1min.ai's dynamic model catalog on startup and caches periodically — new models appear automatically.
- **🔌 OpenAI Compatible Endpoints** — Drop-in replacement for `https://api.openai.com/v1`:
  - `POST /v1/chat/completions` (Chat, Vision, Tool Calling, SSE Streaming)
  - `POST /v1/responses` (OpenAI Structured Responses API with JSON Schema & reasoning effort)
  - `POST /v1/images/generations` (Image generation with `output_format` and `output_quality` controls)
  - `POST /v1/audio/speech` (Multi-engine TTS: OpenAI, Google TTS, and ElevenLabs)
  - `POST /v1/audio/transcriptions` (Multi-format Speech-to-Text: `json`, `text`, `srt`, `vtt`)
  - `POST /v1/audio/translations` (Audio speech translation to English)
  - `GET /v1/models` (OpenRouter-enriched model catalog)
- **🧩 Anthropic Messages API (`POST /v1/messages`)** — Full compatibility with Claude Code, Cursor, and Anthropic SDKs (including `tool_use`, `tool_result`, and Anthropic SSE events).
- **🛠️ ReAct Tool Calling Emulator** — Converts tool schemas into rigid ReAct system instructions and parses balanced JSON outputs back into standard tool calls for models without native function calling.
- **🔬 DeepSeek-R1 / Reasoning `<think>` Stripping** — Isolates and removes `<think>...</think>` internal monologues before tool parsing to ensure 100% benchmark and test harness compatibility (SWE-bench, lm-evaluation-harness, n8n).
- **🛡️ Anti-Leak `ResponseSanitizer`** — Scrubs residual tool tags, leaked JSON, and role prefixes (`Assistant:`, `AI:`) from the final response delivered to the user or TTS synthesizers.
- **📚 RAG & Memory Unpacker** — Unrolls LangChain / Vector Store document JSONs (`pageContent`, metadata timestamps) into clean human-readable context blocks.
- **🌐 Web Hub & Native Search** — Append `:online` to any model ID for 1min.ai native web search. Dedicated `POST /v1/web/fetch` (via Jina Reader) and `POST /v1/search` (via SearXNG).
- **🔢 Accurate Token Estimation** — Integrated `gpt-tokenizer` for accurate BPE token counts on prompts, completions, and streaming headers.
- **📊 Interactive Web Dashboard & Dual-Metric Analytics** — Zero-dependency web UI at `/dashboard` with live request & credit breakdowns (toggle between **Request Count** and **Credits Consumed**), real-time check-in log, wallet balance, and manual check-in trigger.
- **🎁 Resilient Automated Daily Check-in (+15,000 credits/day)** — Built-in background engine that claims the 15,000 daily check-in bonus directly via `api.1min.ai` authentication. Immune to UI/popups/DOM changes, supports RFC 6238 TOTP 2FA, configurable schedules with jitter, and Telegram/Webhook alerts.
- **☁️ Universal Dual-Runtime** — Deploy anywhere:
  - **Docker / Node.js:** Self-hosted standalone container with graceful draining and Prometheus metrics.
  - **Cloudflare Workers:** Serverless global edge deployment using `wrangler.jsonc` and KV-backed state.
- **🔐 Master Proxy or Direct Key Mode** — Protect upstream credentials with `AUTH_TOKEN` or allow clients to pass their own `Authorization: Bearer` / `x-api-key`.

---

## 🗺️ Endpoint Matrix

| Method | Endpoint | Standard | Description |
|---|---|---|---|
| `GET` | `/dashboard` (or `/stats`) | Gateway | Interactive visual Web Dashboard (Request & Credit analytics) |
| `GET` | `/api/stats` | Gateway | Aggregated stats JSON API (models, endpoints, recent requests) |
| `GET` | `/health` | Gateway | Health check & model registry statistics |
| `GET` | `/v1/checkin/status` | Gateway | Check-in status, credit balance, last run result, and history |
| `POST` | `/v1/checkin/run` | Gateway | Manual on-demand check-in trigger |
| `GET` | `/v1/models` | OpenAI | Dynamic model catalog with context length & pricing |
| `POST` | `/v1/chat/completions` | OpenAI | Chat completions, vision input, tool calling, SSE streaming |
| `POST` | `/v1/responses` | OpenAI | Structured Responses API with JSON schema enforcement |
| `POST` | `/v1/messages` | Anthropic | Messages API translation, content blocks, and Anthropic SSE events |
| `POST` | `/v1/images/generations` | OpenAI | Image generation with format (`png`, `webp`, `jpeg`) and quality overrides |
| `POST` | `/v1/audio/speech` | OpenAI | Multi-engine TTS (OpenAI `tts-1`, Google TTS, ElevenLabs) |
| `POST` | `/v1/audio/transcriptions` | OpenAI | Multipart speech-to-text (`json`, `text`, `srt`, `vtt`) |
| `POST` | `/v1/audio/translations` | OpenAI | Spoken audio translation to English |
| `POST` | `/v1/web/fetch` | Gateway | URL markdown and content extraction via Jina Reader |
| `POST` | `/v1/search` | Gateway | Optional SearXNG web search hub |
| `POST` | `/v1/youtube/transcript` | Gateway | YouTube video transcript extraction |
| `GET` | `/v1/metrics` | Prometheus | Prometheus telemetry counters and duration histograms |
| `GET` | `/docs` | OpenAPI | Interactive Swagger / OpenAPI documentation |

---

## 🚀 Quick Start

### 1. Docker (Local or Server Deploy)

```bash
docker run -d \
  --name 1min-bridge \
  -p 3000:3000 \
  -e ONE_MIN_API_KEY=your_1min_api_key \
  ghcr.io/binuengoor/1min-bridge:latest
```

### 2. Cloudflare Workers (Serverless Edge Deploy)

```bash
# Clone and install dependencies
git clone https://github.com/binuengoor/1min-bridge.git
cd 1min-bridge
npm install

# Deploy directly via Wrangler
npx wrangler secret put ONE_MIN_API_KEY
npx wrangler secret put AUTH_TOKEN
npx wrangler deploy
```

---

## 🔑 Authentication Modes

| Mode | Client Header | Gateway Action | Recommended For |
|---|---|---|---|
| **Direct Client Key** | `Authorization: Bearer <1MIN_KEY>` or `x-api-key: <1MIN_KEY>` | Relays key to 1min.ai | Direct developers, trusted local scripts |
| **Master Proxy** | `Authorization: Bearer <AUTH_TOKEN>` or `x-api-key: <AUTH_TOKEN>` | Validates token and injects server `ONE_MIN_API_KEY` | n8n, public frontends, multi-user teams |

---

## 💻 Usage Examples

### 1. OpenAI Chat Completions with Tool Calling

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "YOUR_API_KEY",
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What is the weather in Mantena?" }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Returns the current weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
});

console.log(response.choices[0].finish_reason); // "tool_calls"
console.log(response.choices[0].message.tool_calls);
```

### 2. Anthropic Messages API (`POST /v1/messages`)

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Explain how edge AI gateways work."}
    ]
  }'
```

### 3. OpenAI Structured Responses API (`POST /v1/responses`)

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "input": "Extract user data: Alice, age 28, engineer",
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "user_info",
        "schema": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "age": { "type": "number" },
            "role": { "type": "string" }
          },
          "required": ["name", "age", "role"]
        }
      }
    }
  }'
```

### 4. Multi-Engine Text-to-Speech

```bash
# ElevenLabs voice
curl -X POST http://localhost:3000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "elevenlabs-tts",
    "voice": "21m00Tcm4TlvDq8ikWAM",
    "input": "Hello from 1min-bridge!"
  }' --output speech.mp3

# Google TTS voice
curl -X POST http://localhost:3000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "google-tts",
    "voice": "en-US-Standard-C",
    "input": "Hello from 1min-bridge!"
  }' --output speech.mp3
```

### 3. Automated Daily Check-in (+15,000 Credits)

Check status, balance, and next scheduled check-in:

```bash
curl http://localhost:3000/v1/checkin/status
```

Example response:
```json
{
  "enabled": true,
  "isConfigured": true,
  "lastRun": {
    "success": true,
    "timestamp": "2026-09-01T08:04:12.345Z",
    "userName": "johndoe",
    "initialCredit": 125000,
    "finalCredit": 140000,
    "creditDiff": 15000,
    "availablePercent": "88.5",
    "attemptCount": 1
  },
  "nextScheduledRun": "2026-09-02T08:06:21.000Z",
  "currentBalance": 140000,
  "totalCheckins": 12,
  "successfulCheckins": 12,
  "history": [...]
}
```

Trigger an immediate manual check-in:

```bash
curl -X POST http://localhost:3000/v1/checkin/run
```

### 4. Live Visual Dashboard & Analytics

Open in your browser:
```
http://localhost:3000/dashboard
```

- **Dual-Metric Toggle**: Switch on the fly between **🔢 Request Count** and **💳 Credits Consumed**.
- **Live Logs**: Watch the last 20 requests with HTTP status, latency, tokens, and credit cost.
- **Credit Log**: View the last 10 daily check-in rewards (`+15,000 credits`) and trigger manual check-ins with one click.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ONE_MIN_API_KEY` | — | Server-side default 1min.ai API key |
| `AUTH_TOKEN` | — | Master proxy token for client authentication |
| `PORT` | `3000` | Server listening port (Node.js) |
| `CACHE_TTL_MS` | `1800000` | Model catalog cache TTL in milliseconds (30 min) |
| `ALLOWED_MODELS` | *(all)* | Comma-separated model IDs to expose; empty = all |
| `SEARXNG_URL` | — | Optional SearXNG instance URL for `POST /v1/search` |
| `SEARXNG_SECRET` | — | Optional SearXNG authorization key |
| `LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `text` | Logging format: `text` (dev) or `json` (production) |
| `CHECKIN_ENABLED` | `false` (auto-enabled if email/password set) | Enable/disable the background daily check-in scheduler |
| `CHECKIN_EMAIL` | — | Your 1min.ai account email |
| `CHECKIN_PASSWORD` | — | Your 1min.ai account password |
| `CHECKIN_TOTP_SECRET` | — | Optional Base32 TOTP secret if 2FA is active on your account |
| `CHECKIN_ON_STARTUP` | `true` | Trigger check-in immediately upon container boot |
| `CHECKIN_UTC_HOUR` | `8` (08:00 UTC = 00:00 PST) | Target UTC hour for daily check-in execution |
| `CHECKIN_JITTER_MINUTES` | `10` | Random jitter window (0-N min) to avoid synchronized requests |
| `CHECKIN_TELEGRAM_BOT_TOKEN` | — | Optional Telegram Bot Token for check-in notifications |
| `CHECKIN_TELEGRAM_CHAT_ID` | — | Optional Telegram Chat ID to receive check-in notifications |
| `CHECKIN_WEBHOOK_URL` | — | Optional Discord / Slack / custom webhook URL for check-in alerts |

---

## 🧪 Testing

```bash
# Run unit & integration tests
npm test

# Check TypeScript types
npx tsc --noEmit

# Build distribution
npm run build
```

---

## 📄 License

MIT © [binuengoor](https://github.com/binuengoor)
