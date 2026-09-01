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
  ONE_MIN_CHAT_API_URL: z
    .string()
    .url()
    .default("https://api.1min.ai/api/chat-with-ai"),
  ONE_MIN_CHAT_STREAMING_URL: z
    .string()
    .url()
    .default("https://api.1min.ai/api/chat-with-ai?isStreaming=true"),
  ONE_MIN_MODELS_URL: z.string().url().default("https://api.1min.ai/models"),
  ONE_MIN_ASSET_URL: z.string().url().default("https://api.1min.ai/api/assets"),
  CACHE_TTL_MS: z.string().default("1800000"),
  ALLOWED_MODELS: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FORMAT: z.enum(["text", "json"]).default("text"),
  ONE_MIN_API_KEY: z.string().optional(),
  CHECKIN_ENABLED: z.string().optional(),
  CHECKIN_EMAIL: z.string().optional(),
  CHECKIN_PASSWORD: z.string().optional(),
  CHECKIN_TOTP_SECRET: z.string().optional(),
  CHECKIN_ON_STARTUP: z.string().default("true"),
  CHECKIN_UTC_HOUR: z.string().default("8"),
  CHECKIN_JITTER_MINUTES: z.string().default("10"),
  CHECKIN_TELEGRAM_BOT_TOKEN: z.string().optional(),
  CHECKIN_TELEGRAM_CHAT_ID: z.string().optional(),
  CHECKIN_WEBHOOK_URL: z.string().optional(),
});

function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const allowedModels = env.ALLOWED_MODELS
    ? env.ALLOWED_MODELS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const isExplicitEnabled = env.CHECKIN_ENABLED !== undefined
    ? env.CHECKIN_ENABLED.toLowerCase() === "true" || env.CHECKIN_ENABLED === "1"
    : Boolean(env.CHECKIN_EMAIL && env.CHECKIN_PASSWORD);

  return {
    port: parseInt(env.PORT, 10),
    oneMinApiUrl: env.ONE_MIN_API_URL,
    oneMinStreamingUrl: env.ONE_MIN_STREAMING_URL,
    oneMinChatApiUrl: env.ONE_MIN_CHAT_API_URL,
    oneMinChatStreamingUrl: env.ONE_MIN_CHAT_STREAMING_URL,
    oneMinModelsUrl: env.ONE_MIN_MODELS_URL,
    oneMinAssetUrl: env.ONE_MIN_ASSET_URL,
    cacheTtlMs: parseInt(env.CACHE_TTL_MS, 10),
    allowedModels,
    logLevel: env.LOG_LEVEL,
    logFormat: env.LOG_FORMAT,
    defaultApiKey: env.ONE_MIN_API_KEY || undefined,
    checkin: {
      enabled: isExplicitEnabled,
      email: env.CHECKIN_EMAIL || undefined,
      password: env.CHECKIN_PASSWORD || undefined,
      totpSecret: env.CHECKIN_TOTP_SECRET || undefined,
      onStartup: env.CHECKIN_ON_STARTUP.toLowerCase() === "true" || env.CHECKIN_ON_STARTUP === "1",
      utcHour: parseInt(env.CHECKIN_UTC_HOUR, 10) || 8,
      jitterMinutes: parseInt(env.CHECKIN_JITTER_MINUTES, 10) || 10,
      telegramBotToken: env.CHECKIN_TELEGRAM_BOT_TOKEN || undefined,
      telegramChatId: env.CHECKIN_TELEGRAM_CHAT_ID || undefined,
      webhookUrl: env.CHECKIN_WEBHOOK_URL || undefined,
    },
  };
}

export const config: AppConfig = loadConfig();
