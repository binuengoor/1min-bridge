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

const imageRequestSchema = z.object({
  model: z.string().optional().default("gemini-2.5-flash-image"),
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(10).optional().default(1),
  size: z.string().optional().default("1024x1024"),
  response_format: z.enum(["url", "b64_json"]).optional().default("url"),
  quality: z.enum(["standard", "hd"]).optional(),
  style: z.enum(["vivid", "natural"]).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  output_quality: z.number().min(1).max(100).optional(),
});

const IMAGE_MODEL_ALIASES: Record<string, string> = {
  "dall-e-3": "gemini-2.5-flash-image",
  "dall-e-2": "gemini-2.5-flash-image",
  "dall-e": "gemini-2.5-flash-image",
  "flux-schnell": "gemini-2.5-flash-image",
  "black-forest-labs/flux-schnell": "gemini-2.5-flash-image",
  "flux-dev": "black-forest-labs/flux-2-dev",
  "flux-pro": "black-forest-labs/flux-2-pro",
  "flux-2-klein": "black-forest-labs/flux-2-klein-4b",
  "sdxl": "stable-diffusion-xl-1024-v1-0",
  "stable-diffusion": "stable-diffusion-xl-1024-v1-0",
  "midjourney": "magic-art_7_0",
  "gemini-flash": "gemini-2.5-flash-image",
  "gemini-pro": "gemini-3-pro-image-preview",
};

app.post("/v1/images/generations", async (c) => {
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

  const requestedModel = body.model ?? "gemini-2.5-flash-image";
  let model = IMAGE_MODEL_ALIASES[requestedModel] ?? requestedModel;
  const modelData = await getModelData();

  if (!modelData.imageModelIds.includes(model) && !Object.values(IMAGE_MODEL_ALIASES).includes(model)) {
    model = "gemini-2.5-flash-image";
  }
  c.set("model", model);

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

  const payload = {
    type: "IMAGE_GENERATOR",
    model,
    promptObject,
  };

  try {
    const data = await callFeature(apiKey, payload);
    const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;

    let urls: string[] = [];
    if (Array.isArray(resultObj)) {
      urls = resultObj.filter((u): u is string => typeof u === "string");
    } else if (typeof resultObj === "string") {
      urls = [resultObj];
    }

    // Fix relative image paths from 1min.ai
    const ONEMIN_BASE = "https://api.1min.ai/";
    const resolvedUrls = urls.map((url) =>
      url.startsWith("http") ? url : `${ONEMIN_BASE}${url}`,
    );

    const response: ImageGenerationResponse = {
      created: Math.floor(Date.now() / 1000),
      data: resolvedUrls.map((url) => ({ url })),
    };

    return c.json(response);
  } catch (err) {
    console.error("Image generation error:", err);
    throw err;
  }
});

export default app;
