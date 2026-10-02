// ============================================================================
// 1min-bridge — DeepSeek DSML & Special Token Tool Parser
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

export const DEEPSEEK_TOOL_PREFIXES = [
  "<｜｜DSML",
  "<｜DSML",
  "<||DSML",
  "<|DSML",
  "<DSML",
  "<｜tool",
  "<|tool",
];

export function hasIncompleteDeepSeekToolCall(buffer: string): boolean {
  // If outer calls block is present, it is incomplete until outer calls close
  if (
    /<[｜|]{1,2}DSML[｜|]{1,2}\s*(?:calls|tool_calls|function_calls)/i.test(buffer)
  ) {
    return !/<\/(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?(?:calls|tool_calls|function_calls)>/i.test(
      buffer,
    );
  }
  // Standalone invoke without outer calls
  if (/<(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?invoke\b/i.test(buffer)) {
    return !/<\/(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?invoke>/i.test(buffer);
  }
  // DeepSeek V3 format
  if (/<[｜|]tool calls[｜|]>/i.test(buffer)) {
    return !/<[｜|]tool calls end[｜|]>/i.test(buffer);
  }
  return false;
}

export function stripDeepSeekToolCalls(text: string): string {
  let result = text;
  // Strip DSML outer blocks
  result = result.replace(
    /<[｜|]{1,2}DSML[｜|]{1,2}\s*(?:calls|tool_calls|function_calls)>[\s\S]*?<\/[｜|]{1,2}DSML[｜|]{1,2}\s*(?:calls|tool_calls|function_calls)>/gi,
    "",
  );
  // Strip standalone invoke blocks
  result = result.replace(
    /<(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?invoke\b[\s\S]*?<\/(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?invoke>/gi,
    "",
  );
  // Strip DeepSeek V3 tool call blocks
  result = result.replace(
    /<[｜|]tool calls[｜|]>[\s\S]*?(?:<[｜|]tool calls end[｜|]>|$)/gi,
    "",
  );
  // Strip residual or unclosed DSML / tool tokens
  result = result.replace(/<\/?(?:[｜|]{1,2})?DSML(?:[｜|]{1,2})?[^>]*>/gi, "");
  result = result.replace(/<[｜|]\/?tool[^>]*[｜|]>/gi, "");
  return result;
}

export function parseDeepSeekToolCalls(text: string): ToolCall[] | null {
  const toolCalls: ToolCall[] = [];

  // Pattern 1: DSML invoke (<｜｜DSML｜｜ invoke name="..."> or <｜DSML｜invoke ...>)
  const dsmlInvokePattern =
    /<(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?invoke\b([^>]*)>([\s\S]*?)<\/(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?invoke>/gi;
  let dsmlMatch: RegExpExecArray | null;
  while ((dsmlMatch = dsmlInvokePattern.exec(text)) !== null) {
    const attrs = dsmlMatch[1]!;
    const body = dsmlMatch[2]!;
    const nameMatch = attrs.match(/name=["']?([^"'\s>]+)["']?/i);
    const fnName = nameMatch ? nameMatch[1]! : "unnamed_tool";
    const args: Record<string, unknown> = {};

    const paramPattern =
      /<(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?parameter\b([^>]*)>([\s\S]*?)<\/(?:[｜|]{1,2}DSML[｜|]{1,2}\s*)?parameter>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramPattern.exec(body)) !== null) {
      const pAttrs = pMatch[1]!;
      const rawVal = pMatch[2]!.trim();
      const pNameMatch = pAttrs.match(/name=["']?([^"'\s>]+)["']?/i);
      if (!pNameMatch) continue;
      const pName = pNameMatch[1]!;
      const stringMatch = pAttrs.match(/string=["']?(true|false)["']?/i);
      const isString = stringMatch ? stringMatch[1] === "true" : null;

      if (isString === true) {
        args[pName] = rawVal;
      } else {
        try {
          args[pName] = JSON.parse(rawVal);
        } catch {
          if (rawVal === "true") args[pName] = true;
          else if (rawVal === "false") args[pName] = false;
          else if (!isNaN(Number(rawVal)) && rawVal !== "") args[pName] = Number(rawVal);
          else args[pName] = rawVal;
        }
      }
    }
    toolCalls.push(makeToolCall(fnName, args));
  }
  if (toolCalls.length > 0) return toolCalls;

  // Pattern 2: DeepSeek V3 special token format (<｜tool calls｜>...<｜tool call end｜>)
  const v3BlockPattern = /<[｜|]tool calls[｜|]>([\s\S]*?)(?:<[｜|]tool calls end[｜|]>|$)/gi;
  let v3BlockMatch: RegExpExecArray | null;
  while ((v3BlockMatch = v3BlockPattern.exec(text)) !== null) {
    const blockContent = v3BlockMatch[1]!;
    const v3CallPattern =
      /<[｜|]tool call begin[｜|]>(?:(?:function|tool)<[｜|]tool sep[｜|]>)?([^\s\n`]+)[\s\S]*?(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?\s*<[｜|]tool call end[｜|]>/gi;
    let v3CallMatch: RegExpExecArray | null;
    while ((v3CallMatch = v3CallPattern.exec(blockContent)) !== null) {
      const fnName = v3CallMatch[1]!.trim();
      const rawArgs = v3CallMatch[2]!.trim();
      try {
        toolCalls.push(makeToolCall(fnName, JSON.parse(rawArgs)));
      } catch {
        toolCalls.push(makeToolCall(fnName, { raw: rawArgs }));
      }
    }
  }

  return toolCalls.length > 0 ? toolCalls : null;
}
