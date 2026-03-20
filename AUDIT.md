# 1min-bridge Audit Report

**Date:** 2026-03-20
**Auditor:** Luna

---

## Executive Summary

1min-bridge is a solid foundation — 112 models auto-discovered, clean TypeScript, good error handling, Zod validation, and rich model metadata. Two quick wins identified, plus a few medium-term improvements.

**Verdict:** Production-ready for chat/image/speech. Embeddings and TTS are the main gaps.

---

## Endpoint Test Results

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /health` | ✅ Pass | Returns model counts, cache age |
| `GET /v1/models` | ✅ Pass | 112 models, all enriched fields present |
| `GET /v1/models/:id` | ✅ Pass | Single model lookup works |
| `GET /v1/models/invalid` | ✅ Pass | Returns proper 404 with OpenAI error format |
| `POST /v1/chat/completions` | ✅ Pass | Zod validates model, messages, params |
| `POST /v1/images/generations` | ✅ Pass | Validates prompt, model |
| `POST /v1/audio/transcriptions` | ✅ Pass | Requires multipart/form-data |
| `POST /v1/audio/translations` | ✅ Pass | Endpoint exists |
| Unknown route | ⚠️ Issue | Returns auth error instead of 404 |
| Streaming headers | ⚠️ Issue | Missing `Content-Type: text/event-stream` |

## Model Enrichment

All fields working correctly:

- `context_length` — from `creditMetadata.CONTEXT`
- `top_provider.max_completion_tokens` — from `creditMetadata.MAX_OUTPUT_TOKEN`
- `architecture.modality` — from `modality.INPUT/OUTPUT`
- `supported_parameters` — inferred from model name patterns (reasoning, tools, tool_choice)
- `pricing` — from `creditMetadata.INPUT/OUTPUT`

## Code Quality

- **TypeScript strict types:** ✅ Zero `any` types
- **Input validation:** ✅ Zod schemas for chat, images, audio
- **Error handling:** ✅ Upstream errors mapped to OpenAI format
- **Auth middleware:** ✅ Bearer → API-KEY conversion, proper error responses
- **Rate limiting:** ✅ Per-IP sliding window with Retry-After header

## API Coverage vs 1min.ai

1min.ai supports 34 feature types. We proxy 4:

| Feature | Proxied? | Notes |
|---------|----------|-------|
| CHAT_WITH_AI | ✅ | `/v1/chat/completions` |
| CHAT_WITH_IMAGE | ✅ | Vision via chat completions |
| IMAGE_GENERATOR | ✅ | `/v1/images/generations` |
| SPEECH_TO_TEXT | ✅ | `/v1/audio/transcriptions` |
| AUDIO_TRANSLATOR | ✅ | `/v1/audio/translations` |
| CHAT_WITH_PDF | ❌ | Could map to chat |
| YOUTUBE_SUMMARIZER | ❌ | Custom endpoint needed |
| YOUTUBE_TRANSCRIBER | ❌ | Custom endpoint needed |
| CONTENT_GENERATOR_* | ❌ | Content tools (15+ types) |
| SUMMARIZER | ❌ | Could map to chat |
| CODE_GENERATOR | ❌ | Could map to chat |
| EMBEDDINGS | ❌ | No `/v1/embeddings` |
| TTS | ❌ | No `/v1/audio/speech` |

## Issues

### Critical
*None*

### Important
1. **Unknown routes return auth error** — auth middleware runs before route matching. Invalid paths return `invalid_api_key` instead of 404.
2. **Missing SSE content-type header** — streaming responses should include `Content-Type: text/event-stream`.

### Nice to Have
3. **No embeddings endpoint** — add `/v1/embeddings` if 1min.ai supports embedding models.
4. **No TTS endpoint** — add `/v1/audio/speech` if 1min.ai supports text-to-speech.
5. **Rate limit headers** — add `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` per OpenAI convention.
6. **YouTube summarization** — could expose as custom endpoint or map to chat completions.
7. **Model name `name` field** — include display name from 1min.ai `name` field in model listing.

## Recommendations

1. Fix route ordering so 404s work for unknown paths
2. Add `Content-Type: text/event-stream` to streaming responses
3. Investigate 1min.ai for embedding and TTS support
4. Consider adding YouTube summarization as custom endpoint
5. Add `name` field to model listing (display names from 1min.ai)
