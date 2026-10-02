// ============================================================================
// 1min-bridge — ReAct Tool Calling Emulator & Balanced JSON Parser
// ============================================================================

import type { ChatMessage, ToolCall } from "../types.js";
import { randomUUID } from "node:crypto";
import { ToolJsonParser } from "./tool-json-parser.js";

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

    // Remove <think>...</think> reasoning monologue
    const sanitized = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!sanitized) return null;

    // 1. Try markdown fences ```json ... ```
    const mdMatches = [...sanitized.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
    for (const match of mdMatches) {
      if (!match?.[1]) continue;
      const candidate = match[1].trim();
      const parsed = ToolJsonParser.safeJsonParse(candidate);
      if (parsed) {
        const extracted = ToolJsonParser.extractFromDecoded(parsed, allowedTools);
        if (extracted) return extracted;
      }
    }

    // 2. Balanced JSON parser scanning across all '{'
    const balancedList = ToolJsonParser.extractAllBalancedJsonBlocks(sanitized);
    for (const block of balancedList) {
      const extracted = ToolJsonParser.extractFromDecoded(block, allowedTools);
      if (extracted) return extracted;
    }

    return null;
  }

  static extractAllBalancedJsonBlocks(text: string): unknown[] {
    return ToolJsonParser.extractAllBalancedJsonBlocks(text);
  }

  static normalizeArguments(args: unknown): string {
    return ToolJsonParser.normalizeArguments(args);
  }

  static formatStreamingToolCalls(toolCalls: ToolCall[]) {
    return ToolJsonParser.formatStreamingToolCalls(toolCalls);
  }

  static formatProgressiveToolCallDeltas(toolCalls: ToolCall[], sliceSize = 64) {
    return ToolJsonParser.formatProgressiveToolCallDeltas(toolCalls, sliceSize);
  }

  static findPotentialToolStart(buffer: string): number {
    return ToolJsonParser.findPotentialToolStart(buffer);
  }

  static splitSafeProse(buffer: string): [string, string] {
    return ToolJsonParser.splitSafeProse(buffer);
  }

  static isPotentialToolCallBuffer(buffer: string): boolean {
    return ToolJsonParser.isPotentialToolCallBuffer(buffer);
  }

  /**
   * Primary parser with fallback when balanced-JSON finds nothing.
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

  static safeJsonParse(str: string): unknown {
    return ToolJsonParser.safeJsonParse(str);
  }
}
