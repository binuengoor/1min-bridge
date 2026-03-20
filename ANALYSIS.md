# 1min.ai Relay Analysis & Recommendation

**Date:** 2026-03-20
**Author:** Luna (subagent analysis)

---

## 1. Official 1min.ai API Overview

### Base URLs

| Endpoint | URL |
|----------|-----|
| Features (chat, image, etc.) | `https://api.1min.ai/api/features` |
| Streaming | `https://api.1min.ai/api/features?isStreaming=true` |
| Conversations | `https://api.1min.ai/api/conversations` |
| Assets (image upload) | `https://api.1min.ai/api/assets` |
| **Models (auto-discovery)** | `https://api.1min.ai/models?feature={FEATURE}` |

### Authentication
- Header: `API-KEY: <your-key>` (not Bearer token — the relay converts Bearer → API-KEY)

### Feature Types (request body `type` field)

| Type | Purpose |
|------|---------|
| `CHAT_WITH_AI` | Standard text chat |
| `CHAT_WITH_IMAGE` | Vision/multimodal chat |
| `IMAGE_GENERATOR` | Image generation |
| `SPEECH_TO_TEXT` | Audio transcription |
| `AUDIO_TRANSLATOR` | Audio translation to English |
| `CODE_GENERATOR` | Code generation (some models) |
| + many content generators | Blog, social, email, etc. |

### 🎯 KEY DISCOVERY: Dynamic Model Discovery API

The 1min.ai API has an **undocumented models endpoint** that returns all available models with full metadata:

```
GET https://api.1min.ai/models?feature=UNIFY_CHAT_WITH_AI
GET https://api.1min.ai/models?feature=IMAGE_GENERATOR
GET https://api.1min.ai/models?feature=SPEECH_TO_TEXT
```

**No API key required** for this endpoint (public).

Response shape:
```json
{
  "models": [
    {
      "modelId": "gpt-5",
      "name": "GPT-5 - OpenAI",
      "provider": "openai",
      "status": "ACTIVE",
      "features": ["CHAT_WITH_AI", "CHAT_WITH_IMAGE", "CODE_GENERATOR", ...],
      "creditMetadata": {"INPUT": 1.25, "OUTPUT": 10, "CONTEXT": 400000},
      "modality": {"INPUT": ["text", "image"], "OUTPUT": ["text"]}
    }
  ],
  "total": 66
}
```

Current counts:
- **Chat models:** 66 (GPT-5.2, Claude 4.5 Opus, Gemini 3.1 Pro, Grok 4, DeepSeek V3.2, Qwen3, Mistral Magistral, Perplexity Sonar, etc.)
- **Image models:** 34 (Flux, DALL-E 3, GPT Image 1, Leonardo, Midjourney/Magic Art, Stable Diffusion, Recraft, Qwen Image, Gemini image)
- **Speech models:** 12 (Whisper, Google STT, GPT-4o Transcribe, ElevenLabs, Qwen3 ASR)

Each model entry includes `features` array — models with `CHAT_WITH_IMAGE` in features support vision. Models with `CODE_GENERATOR` support code interpreter.

---

## 2. Existing Relay Analysis

### 2a. Self-Hosted: kokofixcomputers/1min-relay

**Architecture:** Python (Flask + Waitress), Docker-ready with Memcached for rate limiting.

| Aspect | Details |
|--------|---------|
| Language | Python 3 (Flask) |
| Deployment | Docker Compose (Flask + Memcached) |
| Model discovery | ❌ **HARDCODED** — static list in `main.py` (~35 models, many outdated) |
| API format | OpenAI-compatible (`/v1/chat/completions`, `/v1/images/generations`, `/v1/models`) |
| Services supported | Chat (streaming + non-streaming), Image generation, Vision (limited) |
| Missing | Audio/STT, Responses API, Anthropic Messages API |
| Rate limiting | Flask-Limiter + Memcached |
| Token counting | tiktoken + Mistral tokenizer |
| Code quality | Decent but monolithic (single 400-line file). Some bugs (missing commas in model list). |
| Docker | ✅ docker-compose.yml included |
| Model filtering | Env var `SUBSET_OF_ONE_MIN_PERMITTED_MODELS` for allowlisting |

**Issues:**
- Model list is stale — missing GPT-5.x, Claude 4.x, Gemini 2.5+/3.x, Grok 3/4, etc.
- No auto-discovery mechanism
- No audio endpoints
- No structured output / Responses API
- Monolithic single-file architecture

### 2b. Cloudflare Worker: 7a6163/1min-relay-worker

**Architecture:** TypeScript Hono app on Cloudflare Workers with KV for caching.

| Aspect | Details |
|--------|---------|
| Language | TypeScript (Hono framework) |
| Deployment | Cloudflare Workers + KV |
| Model discovery | ✅ **DYNAMIC** — fetches from `api.1min.ai/models?feature=...` with 2-tier cache (memory 5min + KV 1hr) |
| API format | OpenAI-compatible + Anthropic Messages API |
| Services supported | Chat, Image gen, Audio transcription/translation, Responses API, Vision |
| Rate limiting | Cloudflare KV-based (distributed) |
| Token counting | gpt-tokenizer |
| Code quality | Excellent — well-structured, typed, 50+ files, proper separation of concerns |
| Model capabilities | Auto-derived from API response (vision, code interpreter, web search) |
| Special features | `:online` suffix for web search, graceful degradation |

**Issues:**
- Cloudflare Workers = annoying to self-host, update, or debug
- Requires CF account + KV setup
- No Docker option for local/self-hosted deployment
- Tied to CF ecosystem

---

## 3. Auto-Discovery: The Answer is YES

The `api.1min.ai/models` endpoint is the key. The Cloudflare worker already uses it successfully with this pattern:

1. Fetch `GET /models?feature=UNIFY_CHAT_WITH_AI` → chat models
2. Fetch `GET /models?feature=IMAGE_GENERATOR` → image models
3. Fetch `GET /models?feature=SPEECH_TO_TEXT` → speech models
4. Cache results (in-memory for 5 min, persistent for 1 hr)
5. Derive capabilities from each model's `features` array

**This means we can build a relay that NEVER needs manual model updates.**

---

## 4. Recommendation: Option B — Build New Self-Hosted Relay

### Why not Option A (fork existing)?

The self-hosted Python relay is outdated and architecturally limited. Adding auto-discovery would require rewriting most of it anyway. The Cloudflare worker's code is great but can't be easily ported to self-hosted (KV dependencies, CF-specific runtime).

### Why not Option C (use CF worker as-is)?

Binu self-hosts on Proxmox with Docker/Dockge. Cloudflare Workers are:
- Annoying to update (wrangler deploy)
- Hard to debug (no local logs)
- Tied to CF infrastructure
- Can't run alongside other self-hosted services

### Why Option B (build new)?

Building from scratch lets us:
1. **Take the best ideas from both** — dynamic discovery from the worker, Docker-first from the self-hosted version
2. **Use Node.js/TypeScript** — matches the worker's superior code quality but self-hostable
3. **Target Docker from day one** — simple `docker compose up`
4. **Support all 1min.ai services** — chat, image, audio, vision, web search
5. **Never manually update models** — auto-discovery with caching

### Proposed Architecture

```
┌─────────────────────────────────────────┐
│  1min-relay (Node.js / Hono / Docker)   │
│                                         │
│  GET  /v1/models         → auto-disc    │
│  POST /v1/chat/completions → relay      │
│  POST /v1/images/generations → relay    │
│  POST /v1/audio/transcriptions → relay  │
│  POST /v1/responses → relay             │
│                                         │
│  Model Registry (in-memory + Redis)     │
│  └─ fetches /models every 30 min       │
│  └─ derives capabilities per model      │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  api.1min.ai        │
        │  /models            │
        │  /api/features      │
        │  /api/assets        │
        └─────────────────────┘
```

- **Framework:** Hono (lightweight, fast, same as CF worker)
- **Runtime:** Node.js 20+ with Docker
- **Cache:** In-memory with optional Redis for multi-instance
- **Config:** Env vars (API key, port, allowed models, cache TTL)

---

## 5. Skeleton Project

Created at `~/projects/1min-relay-new/` with:

- `package.json` — dependencies (hono, node-fetch, etc.)
- `src/index.ts` — main entry, route registration
- `src/model-registry.ts` — auto-discovery from 1min.ai /models API
- `src/routes/chat.ts` — `/v1/chat/completions` (streaming + non-streaming)
- `src/routes/images.ts` — `/v1/images/generations`
- `src/routes/models.ts` — `/v1/models`
- `src/routes/audio.ts` — `/v1/audio/transcriptions`
- `src/services/onemin.ts` — 1min.ai API client
- `Dockerfile` — multi-stage build
- `docker-compose.yml` — single-command deployment
- `README.md` — setup instructions

### What's Built (skeleton)

- ✅ Project structure and config
- ✅ Model registry with auto-discovery and caching
- ✅ OpenAI-compatible model listing
- ✅ Docker setup

### What Still Needs Implementation

- 🚧 Chat completions endpoint (streaming + non-streaming)
- 🚧 Image generation endpoint
- 🚧 Audio transcription endpoint
- 🚧 Auth middleware (Bearer → API-KEY conversion)
- 🚧 Rate limiting
- 🚧 Vision support (image upload to /api/assets)
- 🚧 Web search (`:online` suffix)
- 🚧 Token counting
- 🚧 Error handling (OpenAI-compatible error format)

The model registry is the hardest part (auto-discovery) and that's done. The relay endpoints are straightforward request forwarding with format transformation.

---

## 6. Quick Start (Once Built)

```bash
cd ~/projects/1min-relay-new
docker compose up -d
```

```bash
# Test model discovery
curl http://localhost:3000/v1/models | jq '.data | length'

# Use with OpenAI SDK
export OPENAI_API_KEY=your-1min-ai-key
export OPENAI_BASE_URL=http://localhost:3000/v1
```

---

## 7. Build Results (Confirmed Working)

**Docker build:** ✅ Multi-stage build, image size ~80MB
**Runtime test:** ✅ Container starts, auto-discovers models, serves OpenAI-compatible API
**Model discovery:** ✅ 112 models loaded (66 chat + 34 image + 12 speech) from live 1min.ai API
**No hardcoded models:** ✅ Zero model IDs in source code — everything fetched dynamically

### Files on LXC

```
~/projects/1min-relay-new/
├── ANALYSIS.md          # This file
├── README.md            # Setup instructions
├── Dockerfile           # Multi-stage Node 22 Alpine
├── docker-compose.yml   # Single-command deploy
├── package.json         # hono + @hono/node-server
├── tsconfig.json        # TypeScript config
├── src/
│   ├── index.ts         # Entry point (Hono + node-server)
│   ├── config.ts        # Env var config
│   ├── types.ts         # TypeScript interfaces
│   ├── model-registry.ts # Auto-discovery with caching
│   └── routes/
│       ├── chat.ts      # /v1/chat/completions
│       ├── images.ts    # /v1/images/generations
│       ├── models.ts    # /v1/models
│       └── audio.ts     # /v1/audio/transcriptions
└── dist/                # Compiled output
```

### Next Steps

1. **Test with real API key** — run with `Authorization: Bearer <key>` and verify chat/image/audio endpoints
2. **Add vision support** — implement image upload to `/api/assets`
3. **Add streaming test** — verify SSE streaming with `stream: true`
4. **Deploy to Dockge** — move to Binus Proxmox Docker setup


---

## 7. Build Results (Confirmed Working)

**Docker build:** ✅ Multi-stage build, image size ~80MB
**Runtime test:** ✅ Container starts, auto-discovers models, serves OpenAI-compatible API
**Model discovery:** ✅ 112 models loaded (66 chat + 34 image + 12 speech) from live 1min.ai API
**No hardcoded models:** ✅ Zero model IDs in source code — everything fetched dynamically

### Files on LXC

```
~/projects/1min-relay-new/
├── ANALYSIS.md          # This file
├── README.md            # Setup instructions
├── Dockerfile           # Multi-stage Node 22 Alpine
├── docker-compose.yml   # Single-command deploy
├── package.json         # hono + @hono/node-server
├── tsconfig.json        # TypeScript config
├── src/
│   ├── index.ts         # Entry point (Hono + node-server)
│   ├── config.ts        # Env var config
│   ├── types.ts         # TypeScript interfaces
│   ├── model-registry.ts # Auto-discovery with caching
│   └── routes/
│       ├── chat.ts      # /v1/chat/completions
│       ├── images.ts    # /v1/images/generations
│       ├── models.ts    # /v1/models
│       └── audio.ts     # /v1/audio/transcriptions
└── dist/                # Compiled output
```

### Next Steps

1. **Test with real API key** — run with `Authorization: Bearer <key>` and verify chat/image/audio endpoints
2. **Add vision support** — implement image upload to `/api/assets`
3. **Add streaming test** — verify SSE streaming with `stream: true`
4. **Deploy to Dockge** — move to Binu's Proxmox Docker setup

---

## 8. Production Build (2026-03-20) — COMPLETE ✅

All requirements from the build specification have been implemented.

### What Was Built

| Feature | Status | Details |
|---------|--------|---------|
| Chat Completions | ✅ | Streaming SSE + non-streaming, vision support |
| Image Generation | ✅ | Flux, DALL-E 3, etc. via /v1/images/generations |
| Audio Transcription | ✅ | /v1/audio/transcriptions (Whisper, etc.) |
| Audio Translation | ✅ | /v1/audio/translations (new) |
| Models endpoint | ✅ | GET /v1/models + GET /v1/models/:modelId |
| Health endpoint | ✅ | GET /health with model counts |
| Auth middleware | ✅ | Bearer → API-KEY conversion |
| Rate limiting | ✅ | Per-key token bucket (60 req/min) |
| Zod validation | ✅ | All request bodies validated |
| Error handling | ✅ | OpenAI-compatible error format |
| TypeScript strict | ✅ | noUncheckedIndexedAccess, no any types |
| Graceful shutdown | ✅ | SIGTERM/SIGINT handlers |
| CORS | ✅ | Permissive for API compatibility |
| Request logging | ✅ | Method, path, status, latency, request ID |

### Architecture (Final)

```
src/
├── index.ts              # Entry point, middleware stack, graceful shutdown
├── config.ts             # Env-driven config (Zod-validated)
├── types.ts              # All TypeScript interfaces (including Hono Env)
├── errors.ts             # RelayError class, OpenAI-compatible error responses
├── model-registry.ts     # Auto-discovery cache (30min TTL, stale fallback)
├── middleware/
│   ├── auth.ts           # Bearer → API-KEY extraction
│   └── rate-limit.ts     # Token bucket rate limiter
├── adapters/
│   └── onemin.ts         # 1min.ai API client (features, streaming, assets)
└── routes/
    ├── health.ts         # GET /, GET /health
    ├── models.ts         # GET /v1/models, GET /v1/models/:modelId
    ├── chat.ts           # POST /v1/chat/completions (Zod, vision, SSE)
    ├── images.ts         # POST /v1/images/generations (Zod)
    └── audio.ts          # POST /v1/audio/{transcriptions,translations}
```

### Key Design Decisions

1. **Middleware stack order:** CORS → Request ID/Logging → Auth → Rate Limit → Route
2. **Hono<Env> generics** for type-safe `c.get("oneMinApiKey")` across all routes
3. **Zod schemas** in each route file for request validation with clear error messages
4. **Adapter pattern:** `src/adapters/onemin.ts` isolates all 1min.ai API interaction
5. **Model registry** is the single source of truth — no hardcoded model IDs anywhere
6. **Docker multi-stage build** with non-root user, tini, healthcheck

### Build Verification

```
$ npm run build          # ✅ Compiles with zero errors
$ docker compose build   # ✅ Multi-stage, ~80MB image
$ docker compose up -d   # ✅ Starts, discovers 112 models
$ curl /health           # ✅ {"status":"ok","models":{"chat":66,"image":34,"speech":12,"total":112}}
$ curl /v1/models        # ✅ 112 models listed with OpenAI-compatible format
```

### Docker

- **Dockerfile:** Multi-stage (build → production), Node 22 Alpine, non-root user, tini init, HEALTHCHECK
- **docker-compose.yml:** Single service, port 3000, env vars for config, healthcheck
- **.dockerignore:** Excludes node_modules, dist, .git, docs

### Remaining for Deployment

1. Deploy to Binu's Proxmox Dockge with a real 1min.ai API key
2. Configure `ALLOWED_MODELS` if needed to restrict model exposure
