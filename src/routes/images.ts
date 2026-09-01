// ============================================================================
// 1min-bridge — POST /v1/images/generations
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { getModelData } from "../model-registry.js";
import { callFeature } from "../adapters/onemin.js";
import { invalidRequestError, sendError } from "../errors.js";
import type { Env, ImageGenerationRequest, ImageGenerationResponse } from "../types.js";

const app = new Hono<Env>();

const imageRequestSchema = z
  .object({
    model: z.string().optional().default("black-forest-labs/flux-2-klein-4b"),
    prompt: z.string().min(1),
    n: z.number().optional().default(1),
    size: z.string().optional().default("1024x1024"),
    response_format: z.string().optional().default("url"),
    quality: z.string().optional(),
    style: z.string().optional(),
    output_format: z.string().optional(),
    output_quality: z.number().optional(),
  })
  .passthrough();

const IMAGE_MODEL_ALIASES: Record<string, string> = {
  "dall-e-3": "black-forest-labs/flux-2-klein-4b",
  "dall-e-2": "black-forest-labs/flux-2-klein-4b",
  "dall-e": "black-forest-labs/flux-2-klein-4b",
  "flux-schnell": "black-forest-labs/flux-2-klein-4b",
  "black-forest-labs/flux-schnell": "black-forest-labs/flux-2-klein-4b",
  "flux-dev": "black-forest-labs/flux-2-dev",
  "flux-pro": "black-forest-labs/flux-2-pro",
  "flux-2-klein": "black-forest-labs/flux-2-klein-4b",
  "sdxl": "stable-diffusion-xl-1024-v1-0",
  "stable-diffusion": "stable-diffusion-xl-1024-v1-0",
  "midjourney": "magic-art_7_0",
  "gemini-flash": "gemini-2.5-flash-image",
  "gemini-pro": "gemini-3-pro-image-preview",
};

const RESILIENT_FALLBACKS = [
  "black-forest-labs/flux-2-klein-4b",
  "gemini-2.5-flash-image",
  "stable-diffusion-xl-1024-v1-0",
];

const handleImageGeneration = async (c: any) => {
  const apiKey = c.get("oneMinApiKey");

  let body: ImageGenerationRequest;
  try {
    const raw = await c.req.json();
    body = imageRequestSchema.parse(raw) as ImageGenerationRequest;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return sendError(c, invalidRequestError(`Validation error: ${msg}`));
    }
    return sendError(c, invalidRequestError("Invalid JSON body"));
  }

  const requestedModel = body.model ?? "black-forest-labs/flux-2-klein-4b";
  let primaryModel = IMAGE_MODEL_ALIASES[requestedModel] ?? requestedModel;
  const modelData = await getModelData();

  if (!modelData.imageModelIds.includes(primaryModel) && !Object.values(IMAGE_MODEL_ALIASES).includes(primaryModel)) {
    primaryModel = "black-forest-labs/flux-2-klein-4b";
  }
  c.set("model", primaryModel);

  const promptObject: Record<string, unknown> = {
    prompt: body.prompt,
    n: body.n ?? 1,
    samples: body.n ?? 1,
    size: body.size ?? "1024x1024",
    imageSize: body.size === "512x512" ? "512" : body.size === "2048x2048" ? "2K" : "1K",
    quality: body.quality ?? "standard",
    aspectRatio: "1:1",
  };

  if (body.output_format) promptObject.output_format = body.output_format;
  if (body.output_quality) promptObject.output_quality = body.output_quality;

  const candidateModels = [
    primaryModel,
    ...RESILIENT_FALLBACKS.filter((m) => m !== primaryModel),
  ];

  let data: any = null;
  let lastError: unknown = null;

  for (const modelToTry of candidateModels) {
    try {
      const payload = {
        type: "IMAGE_GENERATOR",
        model: modelToTry,
        promptObject,
      };
      data = await callFeature(apiKey, payload);
      if (data?.aiRecord?.status === "SUCCESS" || data?.aiRecord?.temporaryUrl || data?.aiRecord?.aiRecordDetail?.resultObject) {
        c.set("model", modelToTry);
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`Image generation failed for ${modelToTry}, attempting fallback...`, (err as Error).message);
    }
  }

  if (!data) {
    console.error("All image generation model attempts failed:", lastError);
    throw lastError;
  }

  // Extract temporary signed S3 URL or resultObject
  const rawAiRecord = data.aiRecord as any;
  let urls: string[] = [];

  if (rawAiRecord?.temporaryUrl && typeof rawAiRecord.temporaryUrl === "string") {
    urls.push(rawAiRecord.temporaryUrl);
  } else if (Array.isArray(rawAiRecord?.temporaryUrls)) {
    urls.push(...rawAiRecord.temporaryUrls.filter((u: unknown) => typeof u === "string"));
  }

  if (urls.length === 0) {
    const resultObj = rawAiRecord?.aiRecordDetail?.resultObject;
    if (Array.isArray(resultObj)) {
      urls = resultObj.filter((u): u is string => typeof u === "string");
    } else if (typeof resultObj === "string") {
      urls = [resultObj];
    }
  }

  const S3_BASE = "https://s3.us-east-1.amazonaws.com/asset.1min.ai/";
  const resolvedUrls = urls.map((url) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    return `${S3_BASE}${url.replace(/^\/+/, "")}`;
  });

  const isB64Requested = body.response_format === "b64_json";

  const imageItems = await Promise.all(
    resolvedUrls.map(async (url) => {
      if (isB64Requested) {
        try {
          const imgRes = await fetch(url);
          if (imgRes.ok) {
            const arrBuf = await imgRes.arrayBuffer();
            const b64 = Buffer.from(arrBuf).toString("base64");
            return { b64_json: b64, url };
          }
        } catch (err) {
          console.error("Failed to convert image to b64_json:", err);
        }
      }
      return { url };
    }),
  );

  const response: ImageGenerationResponse = {
    created: Math.floor(Date.now() / 1000),
    data: imageItems,
  };

  return c.json(response);
};

app.post("/v1/images/generations", handleImageGeneration);
app.post("/images/generations", handleImageGeneration);
app.post("/api/v1/images/generations", handleImageGeneration);

export default app;
