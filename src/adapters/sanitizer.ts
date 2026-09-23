// ============================================================================
// 1min-bridge — Response Sanitizer & Memory Unpacker
// ============================================================================

export class ResponseSanitizer {
  static readonly MAX_MEMORY_CHARS = 8000;

  /**
   * Detects ephemeral 1min.ai crawling / search progress status banners.
   */
  static isCrawlingStatus(text: string): boolean {
    if (!text || typeof text !== "string") return false;
    const trimmed = text.trim();
    return /^(?:🌐|🔍|🔑)\s*(?:Crawling|Searching|Doing Google search|Extracting keywords)/i.test(
      trimmed,
    );
  }

  /**
   * Strips tool-call JSON/XML blocks, returning the prose remainder.
   * Used to preserve user-facing text that precedes tool JSON in streams.
   */
  static stripToolJson(text: string): string {
    if (!text || typeof text !== "string") return "";
    let out = text;
    // Markdown fences containing tool calls
    out = out.replace(/```(?:json)?\s*\{[\s\S]*?"tool_calls"[\s\S]*?```/gi, "");
    // Generic markdown fences that parse as tool calls are handled by caller;
    // here remove explicit alternate formats:
    out = out.replace(/TOOL_CALL:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "");
    out = out.replace(/\[TOOL_CALLS\]\s*\[.*?\]/gs, "");
    out = out.replace(/✿FUNCTION✿:[\s\S]*?✿ARGS✿:\s*\{.*?\}/gs, "");
    out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
    out = out.replace(/<functioncall>[\s\S]*?<\/functioncall>/gi, "");
    out = out.replace(/<invoke>[\s\S]*?<\/invoke>/gi, "");
    return out;
  }

  /**
   * Sanitizes the final assistant response removing execution artifacts,
   * thinking monologue (<think>), residual tool markup, and unwanted prefixes.
   */
  static cleanOutput(text: string): string {
    if (!text || typeof text !== "string") return "";

    let cleaned = text;

    // 1. Remove reasoning blocks (DeepSeek-R1 / QwQ / Hermes), incl. unclosed
    cleaned = cleaned.replace(
      /<(think|thinking|reasoning|thought)[^>]*>[\s\S]*?(<\/\1>|$)/gi,
      "",
    );

    // 2. Remove residual tool tags from XML/Hermes-style models
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
    cleaned = cleaned.replace(/<functioncall>[\s\S]*?<\/functioncall>/gi, "");
    cleaned = cleaned.replace(/<invoke>[\s\S]*?<\/invoke>/gi, "");
    cleaned = cleaned.replace(/<tools>[\s\S]*?<\/tools>/gi, "");

    // 3. Remove leaked "Tool: [...]" or "Tool: {...}" blocks
    cleaned = cleaned.replace(/Tool:\s*(?:\[[\s\S]*?\]|\{[\s\S]*?\})\s*/gi, "");

    // 3b. Remove ReAct echoes that leak into agentic answers
    cleaned = cleaned.replace(
      /^(?:Thought|Action|Observation|Action Input)\s*:\s*.*$/gim,
      "",
    );

    // 4. Remove Markdown code blocks containing raw tool_calls
    cleaned = cleaned.replace(
      /```(?:json)?\s*\{\s*"tool_calls"[\s\S]*?\}\s*```/gi,
      "",
    );

    // 4b. Remove alternate tool markers (Mistral / Qwen / TOOL_CALL:)
    cleaned = cleaned.replace(/\[TOOL_CALLS\]\s*\[.*?\]/gs, "");
    cleaned = cleaned.replace(/✿FUNCTION✿:[\s\S]*?✿ARGS✿:\s*\{.*?\}/gs, "");
    cleaned = cleaned.replace(/TOOL_CALL:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "");

    // 5. Remove search / crawling status introductions
    cleaned = cleaned.replace(
      /^(?:Okay|Ok|Certo|Entendido|Sure)[^.\n]*?(?:procurar|pesquisar|buscar|search|crawling)[^\n]*\n?/gim,
      "",
    );
    cleaned = cleaned.replace(
      /^(?:🌐|🔍|🔑)\s*(?:Crawling|Searching|Doing Google search|Extracting keywords)[^\n]*\n?/gim,
      "",
    );
    cleaned = cleaned.replace(
      /^(?:Crawling|Searching)(?: the web| for| site)?[^\n]*\n?/gim,
      "",
    );
    cleaned = cleaned.replace(
      /^Let me (?:search|look up|check)[^\n]*\n?/gim,
      "",
    );

    // 6. Remove leaked role prefixes at the beginning of lines
    cleaned = cleaned.replace(
      /^(?:Assistant|AI|Emma|Bot|System|Human|User|Tool)\s*:\s*/gim,
      "",
    );

    return cleaned.trim();
  }

  /**
   * Unpacks complex memory payloads (e.g., LangChain Memory, Vector Store Document)
   * converting nested JSON objects with `pageContent` and metadata into clean, readable text.
   */
  static unpackMemoryContent(rawContent: unknown, depth = 0): string {
    if (!rawContent) return "";
    if (depth > 5) return "[nested content truncated]";

    // 1. If already a string, check if it's serialized JSON
    if (typeof rawContent === "string") {
      const trimmed = rawContent.trim();
      if (
        (trimmed.startsWith("[") || trimmed.startsWith("{")) &&
        trimmed.length <= ResponseSanitizer.MAX_MEMORY_CHARS * 2
      ) {
        try {
          const parsed = JSON.parse(trimmed);
          return ResponseSanitizer.unpackMemoryContent(parsed, depth + 1);
        } catch {
          return ResponseSanitizer.capLength(rawContent);
        }
      }
      return ResponseSanitizer.capLength(rawContent);
    }

    // 2. If array (e.g. LangChain documents or multiple tool results)
    if (Array.isArray(rawContent)) {
      // Cap fan-out: first 20 docs only
      const joined = rawContent
        .slice(0, 20)
        .map((item) => ResponseSanitizer.unpackMemoryContent(item, depth + 1))
        .filter(Boolean)
        .join("\n");
      const suffix =
        rawContent.length > 20
          ? `\n...[${rawContent.length - 20} more items truncated]`
          : "";
      return ResponseSanitizer.capLength(joined + suffix);
    }

    // 3. If structured object
    if (typeof rawContent === "object" && rawContent !== null) {
      const record = rawContent as Record<string, unknown>;

      // LangChain Vector Store Document { pageContent: "...", metadata: {...} }
      if (typeof record.pageContent === "string") {
        let text = record.pageContent;
        const metadata = record.metadata as Record<string, unknown> | undefined;
        if (metadata?.timestamp) {
          text += ` (Recorded: ${metadata.timestamp})`;
        }
        return ResponseSanitizer.capLength(text);
      }

      // Generic response/text objects (LangChain, LlamaIndex, misc RAG)
      if (typeof record.text === "string") return ResponseSanitizer.capLength(record.text);
      if (typeof record.content === "string")
        return ResponseSanitizer.capLength(record.content);
      if (typeof record.output === "string")
        return ResponseSanitizer.capLength(record.output);
      if (typeof record.source === "string")
        return ResponseSanitizer.capLength(record.source);
      if (record.response) {
        return ResponseSanitizer.unpackMemoryContent(record.response, depth + 1);
      }
      if (record.data !== undefined && depth < 5) {
        return ResponseSanitizer.unpackMemoryContent(record.data, depth + 1);
      }

      // Fallback: Clean JSON representation (guard circular refs + cap)
      try {
        return ResponseSanitizer.capLength(JSON.stringify(rawContent));
      } catch {
        return "[unserializable content truncated]";
      }
    }

    return ResponseSanitizer.capLength(String(rawContent));
  }

  private static capLength(text: string): string {
    if (text.length <= ResponseSanitizer.MAX_MEMORY_CHARS) return text;
    return (
      text.slice(0, ResponseSanitizer.MAX_MEMORY_CHARS) +
      `...[truncated ${text.length - ResponseSanitizer.MAX_MEMORY_CHARS} chars]`
    );
  }
}
