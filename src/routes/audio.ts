// ============================================================================
// 1min-bridge — Audio Endpoints
// POST /v1/audio/transcriptions
// POST /v1/audio/translations
// POST /v1/audio/speech (Multi-Engine TTS: OpenAI, Google TTS, ElevenLabs)
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { callFeature } from "../adapters/onemin.js";
import { invalidRequestError, sendError } from "../errors.js";
import type { Env, TranscriptionResponse } from "../types.js";

const app = new Hono<Env>();

interface ParsedFormData {
  file: File;
  model: string;
  language: string | null;
  responseFormat: string;
  prompt: string | null;
}

function parseFormData(formData: FormData): ParsedFormData | null {
  const file = formData.get("file");
  if (!(file instanceof File)) return null;

  const model = (formData.get("model") as string) || "whisper-1";
  const language = (formData.get("language") as string) || null;
  const responseFormat = (formData.get("response_format") as string) || "json";
  const prompt = (formData.get("prompt") as string) || null;

  return { file, model, language, responseFormat, prompt };
}

async function handleAudioRequest(
  apiKey: string,
  formData: FormData,
  featureType: "SPEECH_TO_TEXT" | "AUDIO_TRANSLATOR",
): Promise<string> {
  const parsed = parseFormData(formData);
  if (!parsed) {
    return "";
  }

  const { file, model, language, responseFormat, prompt } = parsed;

  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const mimeType = file.type || "audio/mpeg";
  const audioUrl = `data:${mimeType};base64,${base64}`;

  const promptObject: Record<string, unknown> = {
    prompt: prompt ?? "",
    audioUrl,
  };
  if (language) promptObject.language = language;
  promptObject.response_format = responseFormat;

  const payload = {
    type: featureType,
    model,
    promptObject,
  };

  const data = await callFeature(apiKey, payload);
  const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
  if (typeof resultObj === "string") {
    return resultObj;
  }
  if (Array.isArray(resultObj) && typeof resultObj[0] === "string") {
    return resultObj[0];
  }
  return "";
}

// POST /v1/audio/transcriptions
app.post("/v1/audio/transcriptions", async (c) => {
  const apiKey = c.get("oneMinApiKey");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return sendError(c, invalidRequestError("Expected multipart/form-data"));
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return sendError(c, invalidRequestError("'file' field is required"));
  }

  const responseFormat =
    (formData.get("response_format") as string) || "json";
  const model = (formData.get("model") as string) || "whisper-1";
  c.set("model", model);

  const text = await handleAudioRequest(apiKey, formData, "SPEECH_TO_TEXT");

  if (responseFormat === "text" || responseFormat === "srt" || responseFormat === "vtt") {
    return new Response(text, {
      headers: { "Content-Type": "text/plain" },
    });
  }

  const response: TranscriptionResponse = { text };
  return c.json(response);
});

// POST /v1/audio/translations
app.post("/v1/audio/translations", async (c) => {
  const apiKey = c.get("oneMinApiKey");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return sendError(c, invalidRequestError("Expected multipart/form-data"));
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return sendError(c, invalidRequestError("'file' field is required"));
  }

  const responseFormat =
    (formData.get("response_format") as string) || "json";
  const model = (formData.get("model") as string) || "whisper-1";
  c.set("model", model);

  const text = await handleAudioRequest(apiKey, formData, "AUDIO_TRANSLATOR");

  if (responseFormat === "text") {
    return new Response(text, {
      headers: { "Content-Type": "text/plain" },
    });
  }

  const response: TranscriptionResponse = { text };
  return c.json(response);
});

// POST /v1/audio/speech (Multi-engine Text-to-Speech)
const speechSchema = z.object({
  model: z.string().optional().default("tts-1"),
  input: z.string().min(1),
  voice: z.string().optional().default("alloy"),
  response_format: z.string().optional().default("mp3"),
  speed: z.number().optional(),
  speakingRate: z.number().optional(),
  pitch: z.number().optional(),
  languageCode: z.string().optional(),
  voice_settings: z.record(z.string(), z.unknown()).optional(),
});

app.post("/v1/audio/speech", async (c) => {
  const apiKey = c.get("oneMinApiKey");

  let body: z.infer<typeof speechSchema>;
  try {
    const raw = await c.req.json();
    body = speechSchema.parse(raw);
  } catch (err) {
    return sendError(c, invalidRequestError("Field 'input' is required"));
  }

  const { model, input, voice, response_format, speed, speakingRate, pitch, languageCode, voice_settings } = body;
  c.set("model", model);

  let modelForApi = model;
  let promptObject: Record<string, unknown> = {};

  if (model === "google-tts") {
    const lang = languageCode || (voice.length >= 5 ? voice.slice(0, 5) : "en-US");
    promptObject = {
      text: input,
      name: voice || "en-US-Standard-A",
      languageCode: lang,
      speakingRate: speed || speakingRate || 1.0,
      pitch: pitch || 0,
      audioEncoding: response_format.toUpperCase(),
    };
  } else if (model === "elevenlabs-tts" || model.startsWith("eleven_")) {
    modelForApi = "elevenlabs-tts";
    promptObject = {
      text: input,
      voice_id: voice || "Xb7hH8MSUJpSbSDYk0k2",
      model_id: model.startsWith("eleven_") ? model : "eleven_multilingual_v2",
      voice_settings: voice_settings || {
        stability: 0.5,
        similarity_boost: 0.5,
      },
      output_format: response_format === "mp3" ? "mp3_44100_128" : response_format,
    };
  } else {
    // OpenAI standard (tts-1, tts-1-hd)
    promptObject = {
      text: input,
      voice: voice || "alloy",
      response_format,
      speed: speed || 1.0,
    };
  }

  const payload = {
    type: "TEXT_TO_SPEECH",
    model: modelForApi,
    promptObject,
  };

  try {
    const data = await callFeature(apiKey, payload);
    const audioUrl = (data as { aiRecord?: { temporaryUrl?: string; resultObject?: unknown } })?.aiRecord?.temporaryUrl;

    if (audioUrl) {
      // If client accepts binary stream directly, fetch audio and pipe it
      const audioRes = await fetch(audioUrl);
      if (audioRes.ok && audioRes.body) {
        return new Response(audioRes.body, {
          headers: {
            "Content-Type": `audio/${response_format === "mp3" ? "mpeg" : response_format}`,
            "Content-Disposition": `attachment; filename="speech.${response_format}"`,
          },
        });
      }
    }

    const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: audioUrl || String(resultObj) }],
    });
  } catch (err) {
    console.error("Speech generation error:", err);
    throw err;
  }
});

export default app;
