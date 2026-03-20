// ============================================================================
// 1min-relay — POST /v1/images/generations
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { getModelData } from "../model-registry.js";
import { callFeature } from "../adapters/onemin.js";
import { invalidRequestError, modelNotFoundError, sendError } from "../errors.js";
import type { Env, ImageGenerationRequest, ImageGenerationResponse } from "../types.js";

const app = new Hono<Env>();

const imageRequestSchema = z.object({
  model: z.string().optional().default("flux-schnell"),
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(10).optional().default(1),
  size: z.string().optional().default("1024x1024"),
  response_format: z.enum(["url", "b64_json"]).optional().default("url"),
  quality: z.enum(["standard", "hd"]).optional(),
  style: z.enum(["vivid", "natural"]).optional(),
});

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

  const model = body.model ?? "flux-schnell";
  const modelData = await getModelData();

  if (!modelData.imageModelIds.includes(model)) {
    return sendError(c, modelNotFoundError(model));
  }

  const payload = {
    type: "IMAGE_GENERATOR",
    model,
    promptObject: {
      prompt: body.prompt,
      n: body.n ?? 1,
      size: body.size ?? "1024x1024",
    },
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

    const response: ImageGenerationResponse = {
      created: Math.floor(Date.now() / 1000),
      data: urls.map((url) => ({ url })),
    };

    return c.json(response);
  } catch (err) {
    console.error("Image generation error:", err);
    throw err;
  }
});

export default app;
