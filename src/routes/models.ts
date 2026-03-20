// ============================================================================
// 1min-bridge — GET /v1/models (enriched with OpenRouter-compatible fields)
// ============================================================================

import { Hono } from "hono";
import { getModelData } from "../model-registry.js";
import type { Env, OpenAIModel, OneMinModelEntry } from "../types.js";

const app = new Hono<Env>();

/** Map 1min.ai features to OpenRouter supported_parameters */
function supportedParams(entry: OneMinModelEntry): string[] {
  const params = ["max_tokens", "temperature", "top_p", "stop", "stream", "response_format"];

  // Infer tool support from model name patterns
  const id = entry.modelId.toLowerCase();
  const toolModels = ["gpt-4", "gpt-5", "claude", "gemini", "qwen", "mistral-large", "deepseek"];
  if (toolModels.some(m => id.includes(m))) {
    params.push("tools", "tool_choice");
  }

  // Infer reasoning/thinking support
  const reasoningModels = ["o1", "o3", "o4", "claude", "deepseek-reasoner", "gemini", "qwen3"];
  if (reasoningModels.some(m => id.includes(m))) {
    params.push("reasoning");
  }

  return params;
}

/** Build modality string for architecture field */
function buildModality(entry: OneMinModelEntry): string {
  const input = entry.modality?.INPUT || ["text"];
  const output = entry.modality?.OUTPUT || ["text"];
  return input.join("+") + "->" + output.join("+");
}

/** Enrich a model entry with OpenRouter-compatible fields */
function enrichModel(entry: OneMinModelEntry, fetchedAt: number): OpenAIModel {
  const contextLength = (entry.creditMetadata.CONTEXT as number) || undefined;
  const maxOutput = (entry.creditMetadata.MAX_OUTPUT_TOKEN as number) || undefined;
  const inputMods = entry.modality?.INPUT || ["text"];
  const outputMods = entry.modality?.OUTPUT || ["text"];

  const model: OpenAIModel = {
    id: entry.modelId,
    object: "model" as const,
    name: entry.name,
    created: Math.floor(fetchedAt / 1000),
    owned_by: entry.provider || "1min-ai",
  };

  if (contextLength) {
    model.context_length = contextLength;
    model.top_provider = {
      context_length: contextLength,
      max_completion_tokens: maxOutput || null,
    };
  }

  model.architecture = {
    modality: buildModality(entry),
    input_modalities: inputMods,
    output_modalities: outputMods,
  };

  model.supported_parameters = supportedParams(entry);

  // Pricing in credits
  const inputCost = entry.creditMetadata.INPUT as number | undefined;
  const outputCost = entry.creditMetadata.OUTPUT as number | undefined;
  if (inputCost != null && outputCost != null) {
    model.pricing = {
      prompt: String(inputCost),
      completion: String(outputCost),
      unit: "credits_per_token",
    };
  }

  return model;
}

app.get("/v1/models", async (c) => {
  const data = await getModelData();
  const models: OpenAIModel[] = data.entries.map((entry) => enrichModel(entry, data.fetchedAt));

  return c.json({
    object: "list" as const,
    data: models,
  });
});

app.get("/v1/models/:modelId", async (c) => {
  const modelId = c.req.param("modelId");
  const data = await getModelData();
  const entry = data.entries.find((e) => e.modelId === modelId);

  if (!entry) {
    return c.json(
      {
        error: {
          message: "Model '" + modelId + "' not found",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      404,
    );
  }

  return c.json(enrichModel(entry, data.fetchedAt));
});

export default app;
