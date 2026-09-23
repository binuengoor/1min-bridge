// ============================================================================
// 1min-bridge — ReAct Tool Calling Emulator & Balanced JSON Parser
// ============================================================================

import type { ChatMessage, ToolCall } from "../types.js";
import { randomUUID } from "node:crypto";

export interface ToolDefinition {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export class ToolCallingEmulator {
  /**
   * Converts tools (OpenAI or Anthropic format) into rigid ReAct system instructions.
   */
  static injectToolsPrompt(
    systemPrompt: string,
    tools: ToolDefinition[],
    toolChoice?: unknown,
  ): string {
    if (!tools || tools.length === 0 || toolChoice === "none") {
      return systemPrompt;
    }

    const toolDescriptions = tools.map((t) => {
      const name = t.function?.name || t.name || "unnamed_tool";
      const desc = t.function?.description || t.description || "No description provided.";
      const params = t.function?.parameters || t.input_schema || {};
      return `- **${name}**: ${desc}\n  Parameters (JSON Schema): ${JSON.stringify(params)}`;
    });

    let forceInstruction = "";
    if (
      typeof toolChoice === "object" &&
      toolChoice !== null &&
      "function" in toolChoice &&
      typeof (toolChoice as { function?: { name?: string } }).function?.name === "string"
    ) {
      const targetName = (toolChoice as { function: { name: string } }).function.name;
      forceInstruction = `\nATTENTION: You MUST execute the specific tool: "${targetName}".`;
    } else if (
      typeof toolChoice === "object" &&
      toolChoice !== null &&
      "name" in toolChoice &&
      typeof (toolChoice as { name?: string }).name === "string"
    ) {
      const targetName = (toolChoice as { name: string }).name;
      forceInstruction = `\nATTENTION: You MUST execute the specific tool: "${targetName}".`;
    } else if (
      toolChoice === "required" ||
      (typeof toolChoice === "object" &&
        toolChoice !== null &&
        (toolChoice as { type?: string }).type === "any")
    ) {
      forceInstruction = `\nATTENTION: You MUST execute at least one of the available tools before responding.`;
    }

    const injection = `
=== TOOL CALLING EXECUTION SYSTEM ===
You have access to the following tools:
${toolDescriptions.join("\n\n")}
${forceInstruction}

STRICT OUTPUT GUIDELINES:
1. IF you need to call a tool to answer, output ONLY the tool call JSON block.
2. NEVER add chatter like "Let me check...", "Searching for...", greetings, or conversational filler before/after the tool call JSON.
3. IF the required information is already present in conversation history or context, answer DIRECTLY to the user in friendly natural language.
4. NEVER output raw prefixes like 'Tool:', 'Observation:', 'Assistant:' or 'AI:' in your response.
5. NEVER expose raw internal JSON metadata or memory objects to the end user.

Strict Tool Call Format:
\`\`\`json
{
  "tool_calls": [
    {
      "id": "call_${randomUUID().slice(0, 8)}",
      "type": "function",
      "function": {
        "name": "TOOL_NAME",
        "arguments": {
          "param": "value"
        }
      }
    }
  ]
}
\`\`\`
====================================`;

    return systemPrompt ? `${systemPrompt}\n\n${injection}` : injection.trim();
  }

  /**
   * Helper to inject tool calling instructions into a messages list.
   */
  static injectToolsIntoMessages(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolChoice?: unknown,
  ): ChatMessage[] {
    if (!tools || tools.length === 0 || toolChoice === "none") {
      return messages;
    }

    const newMessages = [...messages];
    const sysIdx = newMessages.findIndex(
      (m) => m.role === "system" || m.role === "developer",
    );

    if (sysIdx >= 0) {
      const sysMsg = newMessages[sysIdx]!;
      const existingContent =
        typeof sysMsg.content === "string" ? sysMsg.content : "";
      newMessages[sysIdx] = {
        ...sysMsg,
        content: ToolCallingEmulator.injectToolsPrompt(
          existingContent,
          tools,
          toolChoice,
        ),
      };
    } else {
      newMessages.unshift({
        role: "system",
        content: ToolCallingEmulator.injectToolsPrompt("", tools, toolChoice),
      });
    }

    return newMessages;
  }

  /**
   * Extracts tool calls supporting markdown fences and arbitrary balanced JSON blocks.
   */
  static parseResponse(
    content: string,
    allowedTools?: ToolDefinition[],
  ): ToolCall[] | null {
    if (!content || typeof content !== "string") return null;

    // 0. Remove <think>...</think> reasoning monologue
    const sanitized = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!sanitized) return null;

    // 1. Try markdown fences ```json ... ```
    const mdMatches = [...sanitized.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
    for (const match of mdMatches) {
      if (!match?.[1]) continue;
      const candidate = match[1].trim();
      const parsed = ToolCallingEmulator.safeJsonParse(candidate);
      if (parsed) {
        const extracted = ToolCallingEmulator.extractFromDecoded(
          parsed,
          allowedTools,
        );
        if (extracted) return extracted;
      }
    }

    // 2. Balanced JSON parser scanning across all '{'
    const balancedList = ToolCallingEmulator.extractAllBalancedJsonBlocks(sanitized);
    for (const block of balancedList) {
      const extracted = ToolCallingEmulator.extractFromDecoded(
        block,
        allowedTools,
      );
      if (extracted) return extracted;
    }

    return null;
  }

  /**
   * Balanced brace parser that extracts complete JSON objects from raw text.
   */
  static extractAllBalancedJsonBlocks(text: string): unknown[] {
    const results: unknown[] = [];
    let searchFrom = 0;

    while (searchFrom < text.length) {
      const start = text.indexOf("{", searchFrom);
      if (start === -1) break;

      let braceCount = 0;
      let insideString = false;
      let isEscaped = false;

      for (let i = start; i < text.length; i++) {
        const char = text[i];

        if (insideString) {
          if (isEscaped) {
            isEscaped = false;
          } else if (char === "\\") {
            isEscaped = true;
          } else if (char === '"') {
            insideString = false;
          }
          continue;
        }

        if (char === '"') {
          insideString = true;
          continue;
        }

        if (char === "{") {
          braceCount++;
        } else if (char === "}") {
          braceCount--;
          if (braceCount === 0) {
            const candidate = text.slice(start, i + 1);
            const decoded = ToolCallingEmulator.safeJsonParse(candidate);
            if (decoded && typeof decoded === "object") {
              results.push(decoded);
            }
            searchFrom = i + 1;
            break;
          }
        }
      }

      if (braceCount !== 0) {
        searchFrom = start + 1;
      }
    }

    return results;
  }

  private static extractFromDecoded(
    data: unknown,
    allowedTools?: ToolDefinition[],
  ): ToolCall[] | null {
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;

    const validNames = allowedTools
      ? allowedTools
          .map((t) => t.function?.name || t.name)
          .filter((n): n is string => typeof n === "string")
      : null;

    const isAllowedName = (name: string): boolean => {
      if (!validNames || validNames.length === 0) return true;
      return validNames.includes(name);
    };

    // Pattern A: { tool_calls: [...] }
    if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
      const items: ToolCall[] = [];
      for (const tc of record.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const item = tc as Record<string, unknown>;
        const fnObj = (item.function as Record<string, unknown>) || {};
        const name = (fnObj.name as string) || (item.name as string);
        const rawArgs = fnObj.arguments ?? item.arguments ?? {};
        const argsStr = ToolCallingEmulator.normalizeArguments(rawArgs);

        if (name && isAllowedName(name)) {
          items.push({
            id: (item.id as string) || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name, arguments: argsStr },
          });
        }
      }
      return items.length > 0 ? items : null;
    }

    // Pattern B: Single tool call { name: "...", arguments: {...} }
    if (record.name && typeof record.name === "string") {
      const name = record.name;
      if (
        (record.arguments !== undefined || record.parameters !== undefined) &&
        isAllowedName(name)
      ) {
        const rawArgs = record.arguments ?? record.parameters ?? {};
        return [
          {
            id: `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name,
              arguments: ToolCallingEmulator.normalizeArguments(rawArgs),
            },
          },
        ];
      }
    }

    // Pattern C: { function: { name: "...", arguments: ... } }
    if (
      record.function &&
      typeof record.function === "object" &&
      typeof (record.function as Record<string, unknown>).name === "string"
    ) {
      const fnObj = record.function as Record<string, unknown>;
      const name = fnObj.name as string;
      if (isAllowedName(name)) {
        const rawArgs = fnObj.arguments ?? fnObj.parameters ?? {};
        return [
          {
            id: `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name,
              arguments: ToolCallingEmulator.normalizeArguments(rawArgs),
            },
          },
        ];
      }
    }

    return null;
  }

  /**
   * Normalizes argument objects or strings into a valid serialized JSON string.
   */
  static normalizeArguments(args: unknown): string {
    if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args);
        return JSON.stringify(parsed);
      } catch {
        return JSON.stringify({ input: args });
      }
    } else if (typeof args === "object" && args !== null) {
      return JSON.stringify(args);
    }
    return JSON.stringify({});
  }

  static formatStreamingToolCalls(toolCalls: ToolCall[]) {
    return toolCalls.map((tc, index) => ({
      index,
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }

  /**
   * Builds OpenAI-spec progressive tool-call delta chunks: one starter chunk
   * per tool (id+name+empty args), then ~64-char argument slices, leaving the
   * terminal finish_reason to the caller (emit exactly one).
   */
  static formatProgressiveToolCallDeltas(
    toolCalls: ToolCall[],
    sliceSize = 64,
  ): Array<{ index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }> {
    const deltas: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }> = [];
    toolCalls.forEach((tc, index) => {
      deltas.push({
        index,
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: "" },
      });
      const args = tc.function.arguments ?? "";
      for (let i = 0; i < args.length; i += sliceSize) {
        deltas.push({
          index,
          function: { arguments: args.slice(i, i + sliceSize) },
        });
      }
    });
    return deltas;
  }

  /**
   * Locates the earliest index where a tool-call JSON/XML block may start.
   * Returns -1 when no marker is present (buffer is pure prose).
   */
  static findPotentialToolStart(buffer: string): number {
    const markers = [
      "```json",
      "```",
      '"tool_calls"',
      "tool_calls",
      '"function"',
      "TOOL_CALL:",
      "TOOL_CALL",
      "[TOOL_CALLS]",
      "✿FUNCTION✿",
      "<tool_call",
      "<functioncall",
      '{"name"',
      '{"function"',
    ];
    let earliest = -1;
    for (const m of markers) {
      const idx = buffer.indexOf(m);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
      }
    }
    // Bare "{" only counts when followed by tool-ish keys nearby
    const braceIdx = buffer.indexOf("{");
    if (braceIdx !== -1) {
      const window = buffer.slice(braceIdx, braceIdx + 200);
      if (/\"(name|function|tool_calls|arguments)\"\s*:/.test(window)) {
        if (earliest === -1 || braceIdx < earliest) earliest = braceIdx;
      }
    }
    return earliest;
  }

  /**
   * Splits a streaming buffer into safe prose prefix (flush immediately) and
   * retained suffix (may be incomplete tool JSON). Returns [prose, retained].
   */
  static splitSafeProse(buffer: string): [string, string] {
    const idx = ToolCallingEmulator.findPotentialToolStart(buffer);
    if (idx === -1) return [buffer, ""];
    if (idx === 0) return ["", buffer];
    return [buffer.slice(0, idx), buffer.slice(idx)];
  }

  static isPotentialToolCallBuffer(buffer: string): boolean {
    if (!buffer || !buffer.trim()) return false;
    // Complete tool JSON is handled at end-of-stream; while streaming we only
    // hold back the suffix that could be an incomplete tool block.
    const [, retained] = ToolCallingEmulator.splitSafeProse(buffer);
    return retained.length > 0;
  }

  /**
   * Primary parser with tool-parser.ts fallback (Mistral [TOOL_CALLS],
   * Qwen ✿FUNCTION✿, TOOL_CALL: formats) when balanced-JSON finds nothing.
   */
  static parseResponseWithFallback(
    content: string,
    allowedTools?: ToolDefinition[],
    fallback?: (text: string) => ToolCall[] | null,
  ): ToolCall[] | null {
    const primary = ToolCallingEmulator.parseResponse(content, allowedTools);
    if (primary && primary.length > 0) return primary;
    if (fallback) {
      try {
        const alt = fallback(content);
        if (alt && alt.length > 0) {
          if (!allowedTools || allowedTools.length === 0) return alt;
          const names = new Set(
            allowedTools
              .map((t) => t.function?.name || t.name)
              .filter((n): n is string => typeof n === "string"),
          );
          const filtered = alt.filter((tc) => names.has(tc.function.name));
          return filtered.length > 0 ? filtered : null;
        }
      } catch {
        // fall through to null
      }
    }
    return null;
  }

  private static safeJsonParse(str: string): unknown {
    try {
      return JSON.parse(str);
    } catch {
      // Minimal repair: strip trailing commas and JS-style comments
      try {
        const repaired = str
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(repaired);
      } catch {
        return null;
      }
    }
  }
}
