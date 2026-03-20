// ============================================================================
// 1min-bridge — POST /v1/engines/youtube/summarize
// Summarizes YouTube videos via 1min.ai's YOUTUBE_SUMMARIZER feature
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { callFeature } from "../adapters/onemin.js";
import { invalidRequestError, sendError } from "../errors.js";
import type {
  Env,
  ChatCompletionResponse,
} from "../types.js";

const app = new Hono<Env>();

const youtubeRequestSchema = z.object({
  model: z.string().optional().default("gemini-2.0-flash"),
  youtube_url: z.string().url("youtube_url must be a valid URL"),
  max_tokens: z.number().int().positive().optional(),
});

app.post("/v1/engines/youtube/summarize", async (c) => {
  const apiKey = c.get("oneMinApiKey");

  let body;
  try {
    const raw = await c.req.json();
    body = youtubeRequestSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return sendError(c, invalidRequestError(`Validation error: ${msg}`));
    }
    return sendError(c, invalidRequestError("Invalid JSON body"));
  }

  const payload = {
    type: "YOUTUBE_SUMMARIZER",
    model: body.model,
    promptObject: {
      prompt: body.youtube_url,
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    },
  };

  try {
    const data = await callFeature(apiKey, payload);
    const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
    let content = "";
    if (typeof resultObj === "string") {
      content = resultObj;
    } else if (Array.isArray(resultObj) && typeof resultObj[0] === "string") {
      content = resultObj[0];
    } else if (resultObj && typeof resultObj === "object") {
      content = JSON.stringify(resultObj);
    }

    const response: ChatCompletionResponse = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return c.json(response);
  } catch (err) {
    console.error("YouTube summarize error:", err);
    throw err;
  }
});

export default app;
