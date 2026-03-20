// ============================================================================
// 1min-bridge - Tool Call Parser
// ============================================================================

import type { ToolCall } from "../types.js";

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

export function buildToolSystemPrompt(
  tools: ChatTool[],
  toolChoice?: string,
): string {
  const toolDescriptions = tools.map((tool) => {
    const fn = tool.function;
    const params = fn.parameters || {};
    return "- " + fn.name + ": " + (fn.description || "No description") + "\n  Parameters: " + JSON.stringify(params);
  });

  const toolsBlock = toolDescriptions.join("\n\n");

  let callInstruction: string;
  if (toolChoice === "required") {
    callInstruction = "You MUST call one of the available tools. Do NOT respond with plain text.";
  } else if (toolChoice === "none") {
    return "";
  } else {
    callInstruction = "If the user request can be answered by calling a tool, do so. Otherwise respond normally.";
  }

  return [
    "## Available Tools",
    "",
    "To call a tool, output JSON with name and arguments:",
    "",
    "TOOL_CALL: {\"name\": \"tool_name\", \"arguments\": {\"param\": \"value\"}}",
    "",
    "Available tools:",
    "",
    toolsBlock,
    "",
    callInstruction,
  ].join("\n");
}

export function parseToolCalls(text: string): ToolCall[] | null {
  const toolCalls: ToolCall[] = [];

  // Pattern 1: TOOL_CALL: {...} format
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

  // Pattern 2: Standalone JSON with name + arguments
  const jsonPattern = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
  while ((match = jsonPattern.exec(text)) !== null) {
    try {
      toolCalls.push(makeToolCall(match[1]!, JSON.parse(match[2]!)));
    } catch {
      toolCalls.push(makeToolCall(match[1]!, { raw: match[2]! }));
    }
  }
  if (toolCalls.length > 0) return toolCalls;

  // Pattern 3: Mistral [TOOL_CALLS] [...]
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

  // Pattern 4: Qwen ✿FUNCTION✿ / ✿ARGS✿
  const qwenPattern = /✿FUNCTION✿:\s*(\S+)\s*✿ARGS✿:\s*(\{.*?\})/gs;
  while ((match = qwenPattern.exec(text)) !== null) {
    try {
      toolCalls.push(makeToolCall(match[1]!.trim(), JSON.parse(match[2]!)));
    } catch { /* skip */ }
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

export function stripToolCalls(text: string): string {
  return text
    .replace(/TOOL_CALL:\s*\{[^}]*\}/g, "")
    .replace(/\[TOOL_CALLS\]\s*\[.*?\]/gs, "")
    .replace(/✿FUNCTION✿:[\s\S]*?✿ARGS✿:\s*\{[^}]*\}/gs, "")
    .trim();
}

export function hasIncompleteToolCall(buffer: string): boolean {
  if (buffer.includes("TOOL_CALL:") && !buffer.includes("}")) return true;
  if (buffer.includes("[TOOL_CALLS]") && !/\[TOOL_CALLS\]\s*\[.*\]/.test(buffer)) return true;
  if (buffer.includes("✿FUNCTION✿") && !buffer.includes("✿ARGS✿")) return true;
  return false;
}
