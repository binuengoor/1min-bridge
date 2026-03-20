// ============================================================================
// 1min-relay — Configuration (env-driven, Zod-validated)
// ============================================================================

import { z } from "zod";
import type { AppConfig } from "./types.js";

const envSchema = z.object({
  PORT: z.string().default("3000"),
  ONE_MIN_API_URL: z.string().url().default("https://api.1min.ai/api/features"),
  ONE_MIN_STREAMING_URL: z
    .string()
    .url()
    .default("https://api.1min.ai/api/features?isStreaming=true"),
  ONE_MIN_MODELS_URL: z.string().url().default("https://api.1min.ai/models"),
  ONE_MIN_ASSET_URL: z.string().url().default("https://api.1min.ai/api/assets"),
  CACHE_TTL_MS: z.string().default("1800000"),
  ALLOWED_MODELS: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ONE_MIN_API_KEY: z.string().optional(),
});

function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const allowedModels = env.ALLOWED_MODELS
    ? env.ALLOWED_MODELS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return {
    port: parseInt(env.PORT, 10),
    oneMinApiUrl: env.ONE_MIN_API_URL,
    oneMinStreamingUrl: env.ONE_MIN_STREAMING_URL,
    oneMinModelsUrl: env.ONE_MIN_MODELS_URL,
    oneMinAssetUrl: env.ONE_MIN_ASSET_URL,
    cacheTtlMs: parseInt(env.CACHE_TTL_MS, 10),
    allowedModels,
    logLevel: env.LOG_LEVEL,
    defaultApiKey: env.ONE_MIN_API_KEY || undefined,
  };
}

export const config: AppConfig = loadConfig();
