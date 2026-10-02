// ============================================================================
// 1min-bridge — Tool JSON Extractor & Streaming Formatter
// ============================================================================

import type { ToolCall } from "../types.js";
import type { ToolDefinition } from "./tool-emulator.js";
import { randomUUID } from "node:crypto";

export class ToolJsonParser {
  static safeJsonParse(str: string): unknown {
    try {
      return JSON.parse(str);
    } catch {
      try {
        const repaired = str.replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(repaired);
      } catch {
        return null;
      }
    }
  }

  static normalizeArguments(args: unknown): string {
    if (typeof args === "string") {
      try {
        return JSON.stringify(JSON.parse(args));
      } catch {
        return JSON.stringify({ input: args });
      }
    } else if (typeof args === "object" && args !== null) {
      return JSON.stringify(args);
    }
    return JSON.stringify({});
  }

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
          if (isEscaped) isEscaped = false;
          else if (char === "\\") isEscaped = true;
          else if (char === '"') insideString = false;
          continue;
        }
        if (char === '"') {
          insideString = true;
          continue;
        }
        if (char === "{") braceCount++;
        else if (char === "}") {
          braceCount--;
          if (braceCount === 0) {
            const decoded = ToolJsonParser.safeJsonParse(text.slice(start, i + 1));
            if (decoded && typeof decoded === "object") results.push(decoded);
            searchFrom = i + 1;
            break;
          }
        }
      }
      if (braceCount !== 0) searchFrom = start + 1;
    }
    return results;
  }

  static extractFromDecoded(data: unknown, allowedTools?: ToolDefinition[]): ToolCall[] | null {
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    const validNames = allowedTools
      ? allowedTools.map((t) => t.function?.name || t.name).filter((n): n is string => typeof n === "string")
      : null;
    const isAllowedName = (name: string): boolean => !validNames || validNames.length === 0 || validNames.includes(name);

    if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
      const items: ToolCall[] = [];
      for (const tc of record.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const item = tc as Record<string, unknown>;
        const fnObj = (item.function as Record<string, unknown>) || {};
        const name = (fnObj.name as string) || (item.name as string);
        const argsStr = ToolJsonParser.normalizeArguments(fnObj.arguments ?? item.arguments ?? {});
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

    if (record.name && typeof record.name === "string" && isAllowedName(record.name)) {
      if (record.arguments !== undefined || record.parameters !== undefined) {
        return [{
          id: `call_${randomUUID().slice(0, 8)}`,
          type: "function",
          function: { name: record.name, arguments: ToolJsonParser.normalizeArguments(record.arguments ?? record.parameters ?? {}) },
        }];
      }
    }

    if (record.function && typeof record.function === "object") {
      const fnObj = record.function as Record<string, unknown>;
      const name = fnObj.name as string;
      if (name && isAllowedName(name)) {
        return [{
          id: `call_${randomUUID().slice(0, 8)}`,
          type: "function",
          function: { name, arguments: ToolJsonParser.normalizeArguments(fnObj.arguments ?? fnObj.parameters ?? {}) },
        }];
      }
    }
    return null;
  }

  static formatStreamingToolCalls(toolCalls: ToolCall[]) {
    return toolCalls.map((tc, index) => ({
      index,
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  static formatProgressiveToolCallDeltas(
    toolCalls: ToolCall[],
    sliceSize = 64,
  ): Array<{ index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }> {
    const deltas: Array<{ index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }> = [];
    toolCalls.forEach((tc, index) => {
      deltas.push({ index, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } });
      const args = tc.function.arguments ?? "";
      for (let i = 0; i < args.length; i += sliceSize) {
        deltas.push({ index, function: { arguments: args.slice(i, i + sliceSize) } });
      }
    });
    return deltas;
  }

  static findPotentialToolStart(buffer: string): number {
    const markers = [
      "```json", "```", '"tool_calls"', "tool_calls", '"function"',
      "TOOL_CALL:", "TOOL_CALL", "[TOOL_CALLS]", "✿FUNCTION✿",
      "<tool_call", "<functioncall", '{"name"', '{"function"',
      "<｜｜DSML", "<｜DSML", "<||DSML", "<|DSML", "<DSML", "<｜tool", "<|tool",
    ];
    let earliest = -1;
    for (const m of markers) {
      const idx = buffer.indexOf(m);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
    }
    const braceIdx = buffer.indexOf("{");
    if (braceIdx !== -1) {
      const window = buffer.slice(braceIdx, braceIdx + 200);
      if (/\"(name|function|tool_calls|arguments)\"\s*:/.test(window)) {
        if (earliest === -1 || braceIdx < earliest) earliest = braceIdx;
      }
    }
    return earliest;
  }

  static splitSafeProse(buffer: string): [string, string] {
    const idx = ToolJsonParser.findPotentialToolStart(buffer);
    if (idx === -1) return [buffer, ""];
    if (idx === 0) return ["", buffer];
    return [buffer.slice(0, idx), buffer.slice(idx)];
  }

  static isPotentialToolCallBuffer(buffer: string): boolean {
    if (!buffer || !buffer.trim()) return false;
    const [, retained] = ToolJsonParser.splitSafeProse(buffer);
    return retained.length > 0;
  }
}
