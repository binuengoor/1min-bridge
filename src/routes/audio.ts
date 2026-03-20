// ============================================================================
// 1min-relay — POST /v1/audio/transcriptions & /v1/audio/translations
// ============================================================================

import { Hono } from "hono";
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

  // Convert file to base64 data URL for 1min.ai
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

  const text = await handleAudioRequest(apiKey, formData, "SPEECH_TO_TEXT");

  if (responseFormat === "text") {
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

  const text = await handleAudioRequest(apiKey, formData, "AUDIO_TRANSLATOR");

  if (responseFormat === "text") {
    return new Response(text, {
      headers: { "Content-Type": "text/plain" },
    });
  }

  const response: TranscriptionResponse = { text };
  return c.json(response);
});

export default app;
