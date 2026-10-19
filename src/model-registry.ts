// ============================================================================
// 1min-relay — Dynamic Model Registry (auto-discovery with caching)
// ============================================================================

import { config } from "./config.js";
import type { CachedModelData, OneMinModelEntry, OneMinModelsResponse } from "./types.js";

let cache: CachedModelData | null = null;
let cacheExpiry = 0;
let inflight: Promise<CachedModelData> | null = null;

// Feature keys for the 1min.ai /models endpoint
const FEATURES = {
  chat: "UNIFY_CHAT_WITH_AI",
  image: "IMAGE_GENERATOR",
  speech: "SPEECH_TO_TEXT",
} as const;

async function fetchModels(feature: string): Promise<OneMinModelEntry[]> {
  const url = `${config.oneMinModelsUrl}?feature=${feature}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`Models API returned ${res.status} for feature=${feature}`);
      return [];
    }
    const data = (await res.json()) as OneMinModelsResponse;
    return Array.isArray(data.models) ? data.models : [];
  } catch (err) {
    console.error(`Failed to fetch models for feature=${feature}:`, err);
    return [];
  }
}

function processModels(
  chat: OneMinModelEntry[],
  image: OneMinModelEntry[],
  speech: OneMinModelEntry[],
): CachedModelData {
  const seen = new Set<string>();
  const entries: OneMinModelEntry[] = [];

  for (const m of [...chat, ...image, ...speech]) {
    if (!seen.has(m.modelId)) {
      seen.add(m.modelId);
      entries.push(m);
    }
  }

  const chatIds = chat.map((m) => m.modelId);
  const imageIds = image.map((m) => m.modelId);
  const visionIds = chat
    .filter((m) => m.features.includes("CHAT_WITH_IMAGE"))
    .map((m) => m.modelId);
  const speechIds = speech.map((m) => m.modelId);

  // Filter to allowed models if configured
  if (config.allowedModels?.length) {
    const allowed = new Set(config.allowedModels);
    return {
      chatModelIds: chatIds.filter((id) => allowed.has(id)),
      imageModelIds: imageIds.filter((id) => allowed.has(id)),
      visionModelIds: visionIds.filter((id) => allowed.has(id)),
      speechModelIds: speechIds.filter((id) => allowed.has(id)),
      entries: entries.filter((m) => allowed.has(m.modelId)),
      fetchedAt: Date.now(),
    };
  }

  return {
    chatModelIds: chatIds,
    imageModelIds: imageIds,
    visionModelIds: visionIds,
    speechModelIds: speechIds,
    entries,
    fetchedAt: Date.now(),
  };
}

async function fetchAndProcess(): Promise<CachedModelData> {
  const [chat, image, speech] = await Promise.all([
    fetchModels(FEATURES.chat),
    fetchModels(FEATURES.image),
    fetchModels(FEATURES.speech),
  ]);
  return processModels(chat, image, speech);
}

let chatSet = new Set<string>();
let imageSet = new Set<string>();
let visionSet = new Set<string>();
let speechSet = new Set<string>();
let allSet = new Set<string>();

const FALLBACK_DATA: CachedModelData = {
  chatModelIds: ["gpt-4o", "gpt-4.1", "claude-3-5-sonnet", "gemini-2.0-flash", "deepseek-chat"],
  imageModelIds: ["flux-schnell", "flux-dev", "dall-e-3"],
  visionModelIds: ["gpt-4o", "claude-3-5-sonnet", "gemini-2.0-flash"],
  speechModelIds: ["whisper-1"],
  entries: [
    {
      uuid: "fallback-gpt-4o",
      modelId: "gpt-4o",
      name: "GPT-4o",
      group: "chat",
      provider: "OpenAI",
      status: "active",
      features: ["UNIFY_CHAT_WITH_AI", "CHAT_WITH_IMAGE"],
      creditMetadata: { CONTEXT: 128000, MAX_OUTPUT_TOKEN: 4096 },
      modality: { INPUT: ["text", "image"], OUTPUT: ["text"] },
    },
  ],
  fetchedAt: Date.now(),
};

function updateSets(data: CachedModelData) {
  chatSet = new Set(data.chatModelIds);
  imageSet = new Set(data.imageModelIds);
  visionSet = new Set(data.visionModelIds);
  speechSet = new Set(data.speechModelIds);
  allSet = new Set([...data.chatModelIds, ...data.imageModelIds, ...data.speechModelIds]);
}

export async function getModelData(): Promise<CachedModelData> {
  // In-memory cache
  if (cache && Date.now() < cacheExpiry) return cache;

  // Deduplicate concurrent fetches
  if (inflight) return inflight;

  inflight = fetchAndProcess()
    .then((data) => {
      // If all fetched are empty, fallback or keep existing
      if (data.entries.length === 0 && cache) {
        console.warn("Empty models fetched, preserving existing cache");
        cacheExpiry = Date.now() + config.cacheTtlMs;
        return cache;
      }
      if (data.entries.length === 0 && !cache) {
        console.warn("Models API returned empty list, using fallback defaults");
        cache = FALLBACK_DATA;
      } else {
        cache = data;
      }
      updateSets(cache);
      cacheExpiry = Date.now() + config.cacheTtlMs;
      console.log(
        `Models refreshed: ${cache.chatModelIds.length} chat, ${cache.imageModelIds.length} image, ${cache.speechModelIds.length} speech`,
      );
      return cache;
    })
    .catch((err) => {
      console.error("Failed to fetch models:", err);
      if (cache) {
        console.warn("Using stale cache");
        cacheExpiry = Date.now() + config.cacheTtlMs;
        return cache;
      }
      console.warn("Using fallback default models on startup failure");
      cache = FALLBACK_DATA;
      updateSets(cache);
      cacheExpiry = Date.now() + config.cacheTtlMs;
      return cache;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export async function isValidModel(model: string): Promise<boolean> {
  if (allSet.size === 0) await getModelData();
  return allSet.has(model);
}

export async function isVisionModel(model: string): Promise<boolean> {
  if (visionSet.size === 0) await getModelData();
  return visionSet.has(model);
}

export async function isImageModel(model: string): Promise<boolean> {
  if (imageSet.size === 0) await getModelData();
  return imageSet.has(model);
}

export async function isChatModel(model: string): Promise<boolean> {
  if (chatSet.size === 0) await getModelData();
  return chatSet.has(model);
}

export async function isSpeechModel(model: string): Promise<boolean> {
  if (speechSet.size === 0) await getModelData();
  return speechSet.has(model);
}

/**
 * Returns the top N lowest-cost active chat models from the catalog for resilient keep-alive pings.
 */
export async function getCheapestChatModels(limit = 3): Promise<string[]> {
  const data = await getModelData();
  const candidates = data.entries
    .filter(
      (m) =>
        (m.status === "ACTIVE" || m.status === "active") &&
        data.chatModelIds.includes(m.modelId),
    )
    .map((m) => {
      const inputCost = typeof m.creditMetadata?.INPUT === "number" ? m.creditMetadata.INPUT : 999;
      const outputCost = typeof m.creditMetadata?.OUTPUT === "number" ? m.creditMetadata.OUTPUT : 999;
      return {
        modelId: m.modelId,
        cost: inputCost + outputCost,
      };
    })
    .sort((a, b) => a.cost - b.cost);

  const top = candidates.slice(0, limit).map((c) => c.modelId);
  if (top.length === 0) {
    return ["qwen3.7-flash", "open-mistral-nemo", "ministral-14b-latest"];
  }
  return top;
}
