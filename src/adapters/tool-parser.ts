// ============================================================================
// 1min-bridge - Tool Call Parser
// ============================================================================

import type { ToolCall } from "../types.js";
import {
  parseDeepSeekToolCalls,
  stripDeepSeekToolCalls,
  hasIncompleteDeepSeekToolCall,
  DEEPSEEK_TOOL_PREFIXES,
} from "./deepseek-parser.js";

let callCounter = 0;
function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  callCounter = (callCounter + 1) % 100000;
  return {
    id: "call_" + Date.now().toString(36) + "_" + callCounter.toString(36),
    type: "function" as const,
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ChatTool {
  type: "function";
  function: ToolFunction;
  tool_choice?: string;
}

export function parseToolCalls(text: string): ToolCall[] | null {
  // Pattern 1: DeepSeek DSML & Special Tokens (<｜｜DSML｜｜ ...> or <｜tool calls｜>...)
  // Checked first because explicit XML markup may contain nested JSON arguments inside parameters.
  const dsCalls = parseDeepSeekToolCalls(text);
  if (dsCalls && dsCalls.length > 0) return dsCalls;

  const toolCalls: ToolCall[] = [];

  // Pattern 2: TOOL_CALL: {...} format
  const toolCallPattern = /TOOL_CALL:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}/g;
  let match: RegExpExecArray | null;
  while ((match = toolCallPattern.exec(text)) !== null) {
    try {
      const jsonStart = match.index + match[0].indexOf("{");
      const jsonStr = text.slice(jsonStart);
      const depth = { count: 0 };
      let endIdx = 0;
      for (let i = 0; i < jsonStr.length; i++) {
        if (jsonStr[i] === "{") depth.count++;
        if (jsonStr[i] === "}") depth.count--;
        if (depth.count === 0) { endIdx = i + 1; break; }
      }
      const data = JSON.parse(jsonStr.slice(0, endIdx));
      toolCalls.push(makeToolCall(data.name, data.arguments || {}));
    } catch { /* skip */ }
  }
  if (toolCalls.length > 0) return toolCalls;

  // Pattern 3: Standalone JSON with name + arguments
  const jsonPattern = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
  while ((match = jsonPattern.exec(text)) !== null) {
    try {
      toolCalls.push(makeToolCall(match[1]!, JSON.parse(match[2]!)));
    } catch {
      toolCalls.push(makeToolCall(match[1]!, { raw: match[2]! }));
    }
  }
  if (toolCalls.length > 0) return toolCalls;

  // Pattern 4: Mistral [TOOL_CALLS] [...]
  const mistralPattern = /\[TOOL_CALLS\]\s*(\[.*?\])/gs;
  while ((match = mistralPattern.exec(text)) !== null) {
    try {
      const calls = JSON.parse(match[1]!);
      const arr = Array.isArray(calls) ? calls : [calls];
      for (const call of arr) {
        if (call.name) toolCalls.push(makeToolCall(call.name as string, call.arguments || call.parameters || {}));
      }
    } catch { /* skip */ }
  }
  if (toolCalls.length > 0) return toolCalls;

  // Pattern 5: Qwen ✿FUNCTION✿ / ✿ARGS✿
  const qwenPattern = /✿FUNCTION✿:\s*(\S+)\s*✿ARGS✿:\s*(\{.*?\})/gs;
  while ((match = qwenPattern.exec(text)) !== null) {
    try {
      toolCalls.push(makeToolCall(match[1]!.trim(), JSON.parse(match[2]!)));
    } catch { /* skip */ }
  }
  if (toolCalls.length > 0) return toolCalls;

  return null;
}

export function stripToolCalls(text: string): string {
  let result = text;

  // Strip TOOL_CALL: {...} with balanced braces
  let idx = 0;
  while ((idx = result.indexOf("TOOL_CALL:")) !== -1) {
    const jsonStart = result.indexOf("{", idx);
    if (jsonStart === -1) {
      result = result.slice(0, idx);
      break;
    }
    let depth = 0;
    let endIdx = jsonStart;
    for (let i = jsonStart; i < result.length; i++) {
      if (result[i] === "{") depth++;
      if (result[i] === "}") depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
    result = (result.slice(0, idx) + result.slice(endIdx)).trim();
  }

  // Strip [TOOL_CALLS] [...]
  result = result.replace(/\[TOOL_CALLS\]\s*\[.*?\]/gs, "");

  // Strip ✿FUNCTION✿: ... ✿ARGS✿: {...}
  result = result.replace(/✿FUNCTION✿:[\s\S]*?✿ARGS✿:\s*\{.*?\}/gs, "");

  // Strip DeepSeek DSML & Special Tokens
  result = stripDeepSeekToolCalls(result);

  return result.trim();
}

export function hasIncompleteToolCall(buffer: string): boolean {
  if (buffer.includes("TOOL_CALL:") && (!buffer.includes("}") || !parseToolCalls(buffer))) return true;
  if (buffer.includes("[TOOL_CALLS]") && !/\[TOOL_CALLS\]\s*\[.*?\]/s.test(buffer)) return true;
  if (buffer.includes("✿FUNCTION✿") && (!buffer.includes("✿ARGS✿") || !/✿ARGS✿:\s*\{.*?\}/s.test(buffer))) return true;
  if (hasIncompleteDeepSeekToolCall(buffer)) return true;
  return false;
}

const TOOL_PREFIXES = [
  "TOOL_CALL:",
  "[TOOL_CALLS]",
  "✿FUNCTION✿",
  "TOOL_CALL",
  "[TOOL",
  "✿",
  ...DEEPSEEK_TOOL_PREFIXES,
];

export function isPotentialToolCallBuffer(buffer: string): boolean {
  const trimmed = buffer.trimStart();
  for (const prefix of TOOL_PREFIXES) {
    if (prefix.startsWith(trimmed) || trimmed.startsWith(prefix) || trimmed.includes(prefix)) {
      return true;
    }
  }
  return hasIncompleteToolCall(buffer);
}

export function formatStreamingToolCalls(toolCalls: ToolCall[]) {
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
