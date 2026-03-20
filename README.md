# 1min-bridge

[![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)](https://hub.docker.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-API--compatible-green)](https://platform.openai.com/docs/api-reference)

Self-hosted OpenAI-compatible relay for [1min.ai](https://1min.ai) with **automatic model discovery**.

Unlike existing relays that hardcode model lists, 1min-bridge fetches available models directly from the 1min.ai API on startup and periodically — so when 1min.ai adds new models, they show up automatically. Drop it in place of any OpenAI SDK client and it just works.

---

## Features

- **Auto model discovery** — polls 1min.ai's model registry on startup and every 30 min (configurable)
- **112+ models** — GPT-4o, Claude, Gemini, Llama, Mistral, DeepSeek, Flux, DALL-E 3, Whisper, and more
- **OpenAI-compatible endpoints** — drop-in replacement for `https://api.openai.com`
- **Streaming (SSE)** — real-time token-by-token responses for chat completions
- **Vision support** — send images via `image_url` content parts; auto-uploads to 1min.ai
- **Tool calling emulation** — structured `tools` / `tool_choice` support with JSON function parsing
- **Image generation** — Flux, DALL-E 3, Leonardo, Stable Diffusion, and more
- **Audio transcription & translation** — Whisper, Google STT, GPT-4o Transcribe
- **Web search** — append `:online` to any chat model for web-augmented responses
- **Feature routing via model suffixes** — `:online`, `:pdf`, `:summarize`, `:code` map to 1min.ai features
- **YouTube summarization** — `POST /v1/engines/youtube/summarize`
- **Crawling filter** — strips unwanted UI artifacts from upstream responses
- **Structured SSE adapter** — handles `UNIFY_CHAT_WITH_AI` streaming format
- **Per-IP rate limiting** — 60 requests/minute token bucket
- **Zod validation** — all request bodies validated with clear, structured error messages
- **OpenAPI / Swagger docs** — interactive API documentation at `/docs`
- **Docker-first** — ~80MB multi-stage build, zero config required
- **Strict TypeScript** — zero `any`, `noUncheckedIndexedAccess`, full type safety

---

## Quick Start

```bash
docker run -d \
  --name 1min-bridge \
  -p 3000:3000 \
  -e ONE_MIN_API_KEY=your_1min_api_key \
  1min-bridge
```

Then use it like any OpenAI-compatible endpoint:

```bash
# List available models
curl http://localhost:3000/v1/models

# Health check
curl http://localhost:3000/health

# Chat completion
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_1MIN_API_KEY" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'

# Streaming chat completion
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_1MIN_API_KEY" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Tell me a joke"}],"stream":true}'

# Image generation
curl http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_1MIN_API_KEY" \
  -d '{"model":"flux-schnell","prompt":"a sunset over mountains"}'

# Audio transcription
curl http://localhost:3000/v1/audio/transcriptions \
  -H "Authorization: Bearer YOUR_1MIN_API_KEY" \
  -F "file=@audio.mp3" \
  -F "model=whisper-1"
```

---

## Docker Compose

```yaml
services:
  1min-bridge:
    image: 1min-bridge
    container_name: 1min-bridge
    ports:
      - "3000:3000"
    environment:
      ONE_MIN_API_KEY: your_1min_api_key
      PORT: "3000"
      CACHE_TTL_MS: "1800000"        # 30 minutes
      ALLOWED_MODELS: ""              # empty = all models (comma-separated IDs)
      LOG_LEVEL: "info"              # debug | info | warn | error
    restart: unless-stopped
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ONE_MIN_API_KEY` | *(required)* | Your 1min.ai API key (passed as Bearer token by clients) |
| `PORT` | `3000` | Server port |
| `CACHE_TTL_MS` | `1800000` | Model cache TTL in milliseconds (30 min) |
| `ALLOWED_MODELS` | *(all)* | Comma-separated model IDs to expose; empty = expose all |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `ONE_MIN_MODELS_URL` | `https://api.1min.ai/models` | 1min.ai models API URL |
| `ONE_MIN_API_URL` | `https://api.1min.ai/api/features` | 1min.ai features API URL |
| `ONE_MIN_STREAMING_URL` | `https://api.1min.ai/api/features?isStreaming=true` | 1min.ai streaming API URL |
| `ONE_MIN_ASSET_URL` | `https://api.1min.ai/api/assets` | 1min.ai asset upload URL |

---

## API Reference

### `GET /health`

Health check with model registry status.

**Auth:** Not required

```bash
curl http://localhost:3000/health
```

**Response:**
```json
{
  "status": "ok",
  "models": {
    "chat": 85,
    "image": 15,
    "speech": 12,
    "total": 112
  },
  "cacheAge": 42
}
```

---

### `GET /v1/models`

List all available models with OpenRouter-compatible enrichment fields (`context_length`, `architecture`, `supported_parameters`, `pricing`).

**Auth:** Not required

```bash
curl http://localhost:3000/v1/models
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "name": "GPT-4o",
      "created": 1710000000,
      "owned_by": "openai",
      "context_length": 128000,
      "architecture": {
        "modality": "text+image->text",
        "input_modalities": ["text", "image"],
        "output_modalities": ["text"]
      },
      "top_provider": {
        "context_length": 128000,
        "max_completion_tokens": 16384
      },
      "supported_parameters": ["max_tokens", "temperature", "top_p", "stop", "stream", "response_format", "tools", "tool_choice"],
      "pricing": {
        "prompt": "5",
        "completion": "15",
        "unit": "credits_per_token"
      }
    }
  ]
}
```

---

### `GET /v1/models/:modelId`

Get a specific model by ID.

**Auth:** Not required

```bash
curl http://localhost:3000/v1/models/gpt-4o
```

**Response:** Same as a single model object from the list above. Returns `404` if not found.

---

### `POST /v1/chat/completions`

Chat completion with streaming, vision, and tool calling support.

**Auth:** Required (`Authorization: Bearer <API_KEY>`)

**Streaming:** Set `"stream": true` for SSE response with `data:` chunks.

**Vision:** Include `image_url` content parts in messages (model must support vision).

**Tool calling:** Pass `tools` array and optional `tool_choice`. 1min-bridge emulates tool calling by injecting a system prompt and parsing structured responses.

#### Non-streaming request
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "temperature": 0.7,
    "max_tokens": 500
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-a1b2c3d4-...",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

#### Streaming request
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Count to 5"}],"stream":true}'
```

**Response:** Server-Sent Events (`text/event-stream`):
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"1"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

#### Vision request
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this image?"},
        {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}}
      ]
    }]
  }'
```

#### Tool calling request
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

**Request body fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model ID (supports suffixes — see below) |
| `messages` | array | Yes | Array of message objects (`role`, `content`) |
| `stream` | boolean | No | Enable SSE streaming (default: `false`) |
| `temperature` | number | No | Sampling temperature (0–2) |
| `max_tokens` | integer | No | Max tokens in response |
| `top_p` | number | No | Nucleus sampling (0–1) |
| `frequency_penalty` | number | No | Frequency penalty (-2 to 2) |
| `presence_penalty` | number | No | Presence penalty (-2 to 2) |
| `stop` | string/array | No | Stop sequences |
| `n` | integer | No | Number of completions (1–4) |
| `response_format` | object | No | `{"type": "json_object"}` for structured output |
| `tools` | array | No | Tool/function definitions |
| `tool_choice` | string/object | No | `"auto"`, `"required"`, `"none"`, or `{"type":"function","function":{"name":"..."}}` |

---

### `POST /v1/images/generations`

Generate images using any supported image model.

**Auth:** Required

```bash
curl http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "flux-schnell",
    "prompt": "a cat wearing a space suit, photorealistic",
    "n": 1,
    "size": "1024x1024",
    "response_format": "url"
  }'
```

**Response:**
```json
{
  "created": 1710000000,
  "data": [
    { "url": "https://storage.1min.ai/..." }
  ]
}
```

**Request body fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | Image model (default: `flux-schnell`) |
| `prompt` | string | Yes | Image description |
| `n` | integer | No | Number of images (1–10, default: 1) |
| `size` | string | No | Image size (default: `1024x1024`) |
| `response_format` | string | No | `"url"` or `"b64_json"` (default: `url`) |
| `quality` | string | No | `"standard"` or `"hd"` |
| `style` | string | No | `"vivid"` or `"natural"` |

---

### `POST /v1/audio/transcriptions`

Transcribe audio to text using Whisper or other speech-to-text models.

**Auth:** Required

```bash
curl http://localhost:3000/v1/audio/transcriptions \
  -H "Authorization: Bearer YOUR_KEY" \
  -F "file=@recording.mp3" \
  -F "model=whisper-1" \
  -F "language=en" \
  -F "response_format=json"
```

**Response:**
```json
{ "text": "Hello, this is a transcription of the audio file." }
```

Set `response_format=text` to get plain text instead of JSON.

**Form fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | Audio file (mp3, wav, ogg, m4a, webm) |
| `model` | string | No | Speech model (default: `whisper-1`) |
| `language` | string | No | ISO-639-1 language code |
| `response_format` | string | No | `"json"` or `"text"` (default: `json`) |
| `prompt` | string | No | Optional prompt for context |

---

### `POST /v1/audio/translations`

Translate audio to English text.

**Auth:** Required

```bash
curl http://localhost:3000/v1/audio/translations \
  -H "Authorization: Bearer YOUR_KEY" \
  -F "file=@french_audio.mp3" \
  -F "model=whisper-1"
```

**Response:** Same format as transcriptions.

---

### `POST /v1/engines/youtube/summarize`

Summarize a YouTube video.

**Auth:** Required

```bash
curl http://localhost:3000/v1/engines/youtube/summarize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

---

### `GET /docs`

Interactive Swagger UI documentation (browser).

### `GET /openapi.json`

OpenAPI 3.1.0 specification in JSON format.

---

## Model Suffixes

1min-bridge supports feature routing via model name suffixes. Append a suffix to any chat model to invoke a specific 1min.ai feature:

| Suffix | Feature | Description |
|--------|---------|-------------|
| `:online` | Web Search | Augments the model with real-time web search results |
| `:pdf` | Chat with PDF | Routes to `CHAT_WITH_PDF` — upload and chat with PDF documents |
| `:summarize` | Summarizer | Routes to `SUMMARIZER` — summarize text or URLs |
| `:code` | Code Generator | Routes to `CODE_GENERATOR` — generate code with specialized prompting |

**Example:**
```bash
# Web-augmented chat
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"gpt-4o:online","messages":[{"role":"user","content":"What happened in the news today?"}]}'

# Summarize a document
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"gpt-4o:summarize","messages":[{"role":"user","content":"Summarize this article: https://example.com/article"}]}'
```

---

## Architecture

```
Client (OpenAI SDK, curl, any HTTP client)
    │
    ▼
┌─────────────────────────────────────────┐
│           1min-bridge (Hono)            │
│                                         │
│  Middleware Stack:                       │
│  CORS → Request ID → Logging →          │
│  Auth (Bearer→API-KEY) → Rate Limit     │
│                                         │
│  Routes:                                │
│  /health, /v1/models                    │ ← public (no auth)
│  /v1/chat/completions                   │ ← protected
│  /v1/images/generations                 │ ← protected
│  /v1/audio/*                            │ ← protected
│  /v1/engines/youtube/summarize          │ ← protected
│  /docs, /openapi.json                   │ ← public
│                                         │
│  Model Registry (auto-discovery):       │
│  Polls api.1min.ai/models every 30min   │
│  Caches chat, image, speech models      │
│                                         │
│  Adapters:                              │
│  1min.ai REST API ←→ OpenAI format      │
│  Streaming SSE passthrough              │
│  Tool call emulation (system prompt)    │
│  Crawling filter (response cleanup)     │
└──────────────┬──────────────────────────┘
               │
               ▼
        api.1min.ai
     (112+ models across
      OpenAI, Anthropic, Google,
      Meta, Mistral, DeepSeek,
      Flux, DALL-E, Whisper...)
```

### Key Design Decisions

- **Auto-discovery** — models are fetched from 1min.ai, not hardcoded. The registry refreshes every 30 min.
- **Adapter pattern** — each route translates between OpenAI's request/response format and 1min.ai's API.
- **Tool calling emulation** — since 1min.ai doesn't natively support `tools`, the bridge injects a system prompt with tool schemas and parses the model's structured text response back into `tool_calls`.
- **Vision** — image URLs in messages are uploaded to 1min.ai's asset API and referenced by the returned URLs.
- **Streaming** — upstream SSE is parsed, normalized to OpenAI's `chat.completion.chunk` format, and forwarded.

---

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (hot reload)
npm run dev

# Type check (no emit)
npx tsc --noEmit

# Build
npm run build

# Start production build
npm start
```

### Project Structure

```
src/
├── index.ts              # Entry point, middleware, route mounting
├── config.ts             # Environment config (Zod-validated)
├── types.ts              # TypeScript type definitions
├── errors.ts             # OpenAI-compatible error helpers
├── model-registry.ts     # Auto-discovery & caching
├── openapi-spec.ts       # OpenAPI 3.1.0 specification
├── middleware/
│   ├── auth.ts           # Bearer → API-KEY conversion
│   └── rate-limit.ts     # Per-IP token bucket (60 req/min)
├── adapters/
│   ├── onemin.ts         # 1min.ai API client
│   └── tool-parser.ts    # Tool call parsing from model output
└── routes/
    ├── health.ts         # GET /health, GET /
    ├── models.ts         # GET /v1/models, GET /v1/models/:id
    ├── chat.ts           # POST /v1/chat/completions
    ├── images.ts         # POST /v1/images/generations
    ├── audio.ts          # POST /v1/audio/transcriptions & translations
    └── docs.ts           # GET /docs, GET /openapi.json
```

### Tech Stack

- **Runtime:** Node.js with Hono web framework
- **Language:** TypeScript 5.7 (strict mode, zero `any`)
- **Validation:** Zod schemas on all request bodies
- **HTTP Server:** `@hono/node-server`
- **Containerization:** Docker multi-stage build (~80MB)

---

## Credits

- Powered by [1min.ai](https://1min.ai) — unified API for 112+ AI models
- Built with [Hono](https://hono.dev) — ultrafast web framework
- OpenAI API compatibility per [OpenAI Platform Docs](https://platform.openai.com/docs/api-reference)
