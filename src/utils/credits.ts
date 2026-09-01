// ============================================================================
// 1min-bridge — Credit Estimation Utility
// ============================================================================

import { getModelData } from "../model-registry.js";
import type { OneMinModelEntry } from "../types.js";

/**
 * Calculates estimated credits consumed for a given request.
 *
 * @param modelId Model identifier (e.g. "gpt-4o", "claude-3-5-sonnet", "flux-schnell")
 * @param promptTokens Number of input tokens
 * @param completionTokens Number of output tokens
 * @param feature Optional feature type ("chat", "image", "speech", "web")
 */
export async function calculateCredits(
  modelId?: string,
  promptTokens = 0,
  completionTokens = 0,
  feature: "chat" | "image" | "speech" | "web" = "chat",
): Promise<number> {
  if (!modelId) {
    if (feature === "web") return 10;
    if (feature === "speech") return 20;
    if (feature === "image") return 100;
    return Math.round((promptTokens * 0.05 + completionTokens * 0.15) * 10) / 10;
  }

  // Look up model metadata from registry
  try {
    const data = await getModelData();
    const entry: OneMinModelEntry | undefined = data.entries.find(
      (m) => m.modelId === modelId || modelId.startsWith(m.modelId),
    );

    if (entry && entry.creditMetadata) {
      const meta = entry.creditMetadata;

      // Image generation models
      if (feature === "image" || entry.features.includes("IMAGE_GENERATOR")) {
        const costPerImage = typeof meta.LOW_IMAGE === "number" ? meta.LOW_IMAGE : 100;
        return costPerImage;
      }

      // Audio / Speech models
      if (feature === "speech" || entry.features.includes("SPEECH_TO_TEXT")) {
        return 25;
      }

      // Chat / Text models
      const inputRate = typeof meta.INPUT === "number" && meta.INPUT > 0 ? meta.INPUT : 0.05;
      const outputRate = typeof meta.OUTPUT === "number" && meta.OUTPUT > 0 ? meta.OUTPUT : 0.15;

      const totalCredits = promptTokens * inputRate + completionTokens * outputRate;
      return Math.round(totalCredits * 10) / 10;
    }
  } catch {
    // Fallback to heuristic calculation
  }

  // Heuristic fallbacks
  if (feature === "image") return 100;
  if (feature === "speech") return 20;
  if (feature === "web") return 10;

  const cost = promptTokens * 0.05 + completionTokens * 0.15;
  return Math.round(cost * 10) / 10;
}
