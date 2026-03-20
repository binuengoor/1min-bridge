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

export async function getModelData(): Promise<CachedModelData> {
  // In-memory cache
  if (cache && Date.now() < cacheExpiry) return cache;

  // Deduplicate concurrent fetches
  if (inflight) return inflight;

  inflight = fetchAndProcess()
    .then((data) => {
      cache = data;
      cacheExpiry = Date.now() + config.cacheTtlMs;
      console.log(
        `Models refreshed: ${data.chatModelIds.length} chat, ${data.imageModelIds.length} image, ${data.speechModelIds.length} speech`,
      );
      return data;
    })
    .catch((err) => {
      console.error("Failed to fetch models:", err);
      if (cache) {
        console.warn("Using stale cache");
        cacheExpiry = Date.now() + config.cacheTtlMs;
        return cache;
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export async function isValidModel(model: string): Promise<boolean> {
  const data = await getModelData();
  return (
    data.chatModelIds.includes(model) ||
    data.imageModelIds.includes(model) ||
    data.speechModelIds.includes(model)
  );
}

export async function isVisionModel(model: string): Promise<boolean> {
  const data = await getModelData();
  return data.visionModelIds.includes(model);
}

export async function isImageModel(model: string): Promise<boolean> {
  const data = await getModelData();
  return data.imageModelIds.includes(model);
}
