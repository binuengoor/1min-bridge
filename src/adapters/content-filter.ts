// ============================================================================
// 1min-bridge — Content filter for 1min.ai UI/crawl noise
// ============================================================================

/**
 * Patterns that indicate UI status/chrome messages from 1min.ai
 * rather than actual AI-generated content.
 */
const CRAWL_PATTERNS: RegExp[] = [
  /^\s*🌐\s*Crawling\s+site/i,
  /^\s*🌐\s*Fetching/i,
  /⚡\s*Extracting\s+content\s+from/i,
  /^\s*Crawl\s+results\s*:/i,
  /^\s*🔍\s*Searching/i,
  /^\s*📡\s*Fetching/i,
  /^\s*⚡\s*Processing/i,
  /^\s*📊\s*Analyzing/i,
];

/**
 * Filter out crawl/status noise from content string.
 * Works on full responses or individual streaming chunks.
 */
export function filterCrawlContent(content: string): string {
  if (!content) return content;
  const lines = content.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return !CRAWL_PATTERNS.some((p) => p.test(trimmed));
  });
  return filtered.join("\n").trim();
}

/**
 * Check if a chunk is pure crawl noise (for streaming pre-filter).
 */
export function isCrawlNoise(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (!trimmed) return false;
  return CRAWL_PATTERNS.some((p) => p.test(trimmed));
}
