// ============================================================================
// 1min-bridge — POST /v1/messages (Anthropic Messages API Compatibility)
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getModelData } from "../model-registry.js";
import {
  callOpenAiChat,
  callOpenAiChatStream,
  callChat,
  callChatStream,
  extractLegacyText,
  forcesToolCall,
  iterateOpenAiSse,
  recordUsageMetrics,
  routeViaOpenAi,
  shouldFallbackToLegacy,
  toNativeOpenAiMessages,
  toNativeToolChoice,
  toNativeTools,
  type OpenAiChatBody,
} from "../adapters/onemin.js";
import { invalidRequestError, modelNotFoundError, sendError } from "../errors.js";
import {
  ToolCallingEmulator,
  type ToolDefinition,
} from "../adapters/tool-emulator.js";
import { parseToolCalls } from "../adapters/tool-parser.js";
import { ResponseSanitizer } from "../adapters/sanitizer.js";
import { calculateTokens } from "../utils/tokens.js";
import type {
  Env,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicContentBlock,
  ChatMessage,
  OneMinRequestBody,
} from "../types.js";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Zod schema for Anthropic Messages API
// ---------------------------------------------------------------------------

const anthropicContentBlockSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    source: z.object({
      type: z.literal("base64"),
      media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
      data: z.string(),
    }),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
    is_error: z.boolean().optional(),
  }),
]);

const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicContentBlockSchema), z.null(), z.unknown()]),
});

const anthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const anthropicRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(anthropicMessageSchema).min(1),
  system: z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))]).optional(),
  max_tokens: z.number().int().positive().optional().default(4096),
  metadata: z.record(z.string(), z.unknown()).optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  // Upstream 1min.ai passthrough (nested promptObject.settings)
  brandVoiceId: z.string().optional(),
  withMemories: z.boolean().optional(),
  numOfSite: z.number().int().min(1).max(10).optional(),
  maxWord: z.number().int().min(100).max(10000).optional(),
  historyMessageLimit: z.number().int().min(1).max(50).optional(),
  conversationId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function convertAnthropicToInternalMessages(
  messages: Array<{ role: "user" | "assistant"; content: unknown }>,
  system?: string | Array<{ type: "text"; text: string }>,
): ChatMessage[] {
  const internalMessages: ChatMessage[] = [];

  if (system) {
    const systemText =
      typeof system === "string"
        ? system
        : system.map((b) => b.text).join("\n");
    if (systemText.trim()) {
      internalMessages.push({
        role: "system",
        content: systemText.trim(),
      });
    }
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      internalMessages.push({
        role: msg.role,
        content: msg.content,
      });
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;

        if (b.type === "text" && typeof b.text === "string") {
          internalMessages.push({
            role: msg.role,
            content: b.text,
          });
        } else if (b.type === "tool_use") {
          internalMessages.push({
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: (b.id as string) || `toolu_${randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                  name: b.name as string,
                  arguments: JSON.stringify(b.input || {}),
                },
              },
            ],
          });
        } else if (b.type === "tool_result") {
          const rawContent = b.content;
          const cleanText = ResponseSanitizer.unpackMemoryContent(rawContent);
          internalMessages.push({
            role: "tool",
            tool_call_id: b.tool_use_id as string,
            content: cleanText,
          });
        }
      }
      continue;
    }

    if (msg.content) {
      internalMessages.push({
        role: msg.role,
        content: String(msg.content),
      });
    }
  }

  return internalMessages;
}

function formatMessagesFor1Min(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const m of messages) {
    if (m.role === "tool" || m.role === "function") {
      const cleanContent = ResponseSanitizer.unpackMemoryContent(m.content);
      const prefix = m.tool_call_id
        ? `[System Context - Retrieved Tool Result for ${m.tool_call_id}]:`
        : `[System Context - Retrieved Tool Result]:`;
      parts.push(`${prefix}\n${cleanContent}`);
      continue;
    }

    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const callsStr = m.tool_calls
        .map((tc) => {
          const fnName = tc.function?.name || "unnamed_tool";
          const fnArgs = tc.function?.arguments ?? "{}";
          const argsStr =
            typeof fnArgs === "string" ? fnArgs : JSON.stringify(fnArgs);
          return `${fnName}(${argsStr})`;
        })
        .join(", ");
      parts.push(`[Assistant called tool: ${callsStr}]`);
      continue;
    }

    const roleLabel =
      m.role === "system" || m.role === "developer"
        ? "System"
        : m.role === "assistant"
          ? "Assistant"
          : "Human";

    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (m.content) {
      text = ResponseSanitizer.unpackMemoryContent(m.content);
    }

    if (text) {
      parts.push(`${roleLabel}: ${text}`);
    }
  }

  return parts.join("\n\n");
}

function writeAnthropicSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  eventType: string,
  data: unknown,
) {
  controller.enqueue(
    encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`),
  );
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

app.post("/v1/messages", async (c) => {
  const apiKey = c.get("oneMinApiKey");

  let body: AnthropicMessageRequest;
  try {
    const raw = await c.req.json();
    body = anthropicRequestSchema.parse(raw) as unknown as AnthropicMessageRequest;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return sendError(c, invalidRequestError(`Validation error: ${msg}`));
    }
    return sendError(c, invalidRequestError("Invalid JSON body"));
  }

  const { messages, system, stream, tools, tool_choice } = body;
  const rawModel = body.model;
  const webSearch = rawModel.endsWith(":online");
  const cleanModel = webSearch ? rawModel.slice(0, -7) : rawModel;

  // Validate model
  const modelData = await getModelData();
  if (!modelData.chatModelIds.includes(cleanModel)) {
    return sendError(c, modelNotFoundError(rawModel));
  }

  // Convert to internal messages
  let internalMessages = convertAnthropicToInternalMessages(
    messages as Array<{ role: "user" | "assistant"; content: unknown }>,
    system,
  );

  const baseMessages = internalMessages; // pre-ReAct-injection, for native tools

  const isToolChoiceNone =
    (tool_choice as unknown) === "none" ||
    (typeof tool_choice === "object" &&
      tool_choice !== null &&
      (tool_choice as { type?: string }).type === "none");
  const hasTools =
    Array.isArray(tools) && tools.length > 0 && !isToolChoiceNone;
  if (hasTools && tools) {
    const normalizedTools: ToolDefinition[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema:
        t.input_schema ||
        (t as { parameters?: Record<string, unknown> }).parameters,
    }));
    internalMessages = ToolCallingEmulator.injectToolsIntoMessages(
      internalMessages,
      normalizedTools,
      tool_choice,
    );
  }

  const prompt = formatMessagesFor1Min(internalMessages);
  c.set("model", cleanModel);
  c.set("promptTokens", calculateTokens(prompt));
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const mExtra = body as unknown as Record<string, unknown>;
  const payload: OneMinRequestBody = {
    type: "UNIFY_CHAT_WITH_AI",
    model: cleanModel,
    ...(typeof mExtra.brandVoiceId === "string" ? { brandVoiceId: mExtra.brandVoiceId } : {}),
    promptObject: {
      prompt,
      ...(typeof mExtra.conversationId === "string" ? { conversationId: mExtra.conversationId } : {}),
      settings: {
        webSearchSettings: {
          webSearch,
          ...(typeof mExtra.numOfSite === "number" ? { numOfSite: mExtra.numOfSite } : {}),
          ...(typeof mExtra.maxWord === "number" ? { maxWord: mExtra.maxWord } : {}),
        },
        historySettings: {
          isMixed: false,
          ...(typeof mExtra.historyMessageLimit === "number"
            ? { historyMessageLimit: mExtra.historyMessageLimit }
            : {}),
        },
        ...(typeof mExtra.withMemories === "boolean" ? { withMemories: mExtra.withMemories } : {}),
      },
      ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
    },
  };

  // Anthropic requests are translated into OpenAI chat completions against the
  // 1min.ai OpenAI upstream (native tools). Legacy-only features and models the
  // endpoint does not serve use /api/chat-with-ai with ReAct-emulated tools.
  const legacyOnly =
    webSearch ||
    ["brandVoiceId", "conversationId", "numOfSite", "maxWord", "historyMessageLimit", "withMemories"].some(
      (k) => mExtra[k] !== undefined,
    );
  const viaOpenAi = !legacyOnly && (await routeViaOpenAi(apiKey, cleanModel));
  const stopSeq = (body as unknown as { stop_sequences?: string[] }).stop_sequences;
  const nativeBody: OpenAiChatBody = {
    model: cleanModel,
    messages: toNativeOpenAiMessages(baseMessages),
    ...(hasTools && tools ? { tools: toNativeTools(tools as unknown as ToolDefinition[]) } : {}),
    ...(hasTools && toNativeToolChoice(tool_choice) !== undefined
      ? { tool_choice: toNativeToolChoice(tool_choice) }
      : {}),
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(typeof mExtra.temperature === "number" ? { temperature: mExtra.temperature } : {}),
    ...(typeof mExtra.top_p === "number" ? { top_p: mExtra.top_p } : {}),
    ...(stopSeq?.length ? { stop: stopSeq } : {}),
  };
  const stopReasonOf = (finish: string | null | undefined, hasCalls: boolean) =>
    hasCalls || finish === "tool_calls"
      ? "tool_use"
      : finish === "length"
        ? "max_tokens"
        : "end_turn";

  if (viaOpenAi) {
    try {
      if (stream) {
        const raw = await callOpenAiChatStream(apiKey, nativeBody);
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              const approxIn = Math.ceil(JSON.stringify(nativeBody.messages).length / 4);
              writeAnthropicSSE(controller, encoder, "message_start", {
                type: "message_start",
                message: {
                  id: messageId,
                  type: "message",
                  role: "assistant",
                  content: [],
                  model: cleanModel,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: approxIn, output_tokens: 0 },
                },
              });
              writeAnthropicSSE(controller, encoder, "ping", { type: "ping" });

              let nextIndex = 0;
              let openIndex: number | null = null;
              let openKind: "text" | "tool" | null = null;
              const toolBlocks = new Map<number, number>(); // upstream index -> block index
              let finish: string | null = null;
              let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
              let sawTool = false;
              const closeBlock = () => {
                if (openIndex !== null) {
                  writeAnthropicSSE(controller, encoder, "content_block_stop", {
                    type: "content_block_stop",
                    index: openIndex,
                  });
                  openIndex = null;
                  openKind = null;
                }
              };
              try {
                for await (const chunk of iterateOpenAiSse(raw)) {
                  if (chunk.usage) usage = chunk.usage;
                  const choice = chunk.choices?.[0];
                  if (!choice) continue;
                  if (choice.finish_reason) finish = choice.finish_reason;
                  const text = choice.delta?.content;
                  if (typeof text === "string" && text) {
                    if (openKind !== "text") {
                      closeBlock();
                      openIndex = nextIndex++;
                      openKind = "text";
                      writeAnthropicSSE(controller, encoder, "content_block_start", {
                        type: "content_block_start",
                        index: openIndex,
                        content_block: { type: "text", text: "" },
                      });
                    }
                    writeAnthropicSSE(controller, encoder, "content_block_delta", {
                      type: "content_block_delta",
                      index: openIndex,
                      delta: { type: "text_delta", text },
                    });
                  }
                  for (const tc of choice.delta?.tool_calls ?? []) {
                    sawTool = true;
                    let blockIdx = toolBlocks.get(tc.index);
                    if (blockIdx === undefined) {
                      closeBlock();
                      blockIdx = nextIndex++;
                      toolBlocks.set(tc.index, blockIdx);
                      openIndex = blockIdx;
                      openKind = "tool";
                      const rawId = tc.id || `call_${randomUUID().slice(0, 12)}`;
                      writeAnthropicSSE(controller, encoder, "content_block_start", {
                        type: "content_block_start",
                        index: blockIdx,
                        content_block: {
                          type: "tool_use",
                          id: rawId.replace(/^call_/, "toolu_"),
                          name: tc.function?.name ?? "",
                          input: {},
                        },
                      });
                    }
                    if (tc.function?.arguments) {
                      writeAnthropicSSE(controller, encoder, "content_block_delta", {
                        type: "content_block_delta",
                        index: blockIdx,
                        delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                      });
                    }
                  }
                }
                closeBlock();
                recordUsageMetrics(cleanModel, usage);
                writeAnthropicSSE(controller, encoder, "message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: stopReasonOf(finish, sawTool), stop_sequence: null },
                  usage: { output_tokens: usage?.completion_tokens ?? 0 },
                });
                writeAnthropicSSE(controller, encoder, "message_stop", { type: "message_stop" });
                controller.close();
              } catch (err) {
                console.error("Anthropic native streaming error:", err);
                controller.error(err);
              }
            },
          }),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "anthropic-version": "2023-06-01",
              "X-Bridge-Route": "openai",
            },
          },
        );
      }

      const res = await callOpenAiChat(apiKey, nativeBody);
      const msg = res.choices?.[0]?.message;
      const calls = msg?.tool_calls ?? [];
      const text = ResponseSanitizer.stripReasoning(msg?.content ?? "");
      if (!(hasTools && forcesToolCall(tool_choice) && calls.length === 0)) {
        const blocks: AnthropicContentBlock[] = [];
        if (text) blocks.push({ type: "text", text });
        for (const tc of calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            input = { raw: tc.function.arguments };
          }
          blocks.push({
            type: "tool_use",
            id: (tc.id || `call_${randomUUID().slice(0, 12)}`).replace(/^call_/, "toolu_"),
            name: tc.function.name,
            input,
          });
        }
        if (blocks.length === 0) blocks.push({ type: "text", text: "" });
        const inTok = res.usage?.prompt_tokens ?? 0;
        const outTok = res.usage?.completion_tokens ?? 0;
        c.set("promptTokens", inTok);
        c.set("completionTokens", outTok);
        const response: AnthropicMessageResponse = {
          id: messageId,
          type: "message",
          role: "assistant",
          content: blocks,
          model: cleanModel,
          stop_reason: stopReasonOf(res.choices?.[0]?.finish_reason, calls.length > 0),
          stop_sequence: null,
          usage: { input_tokens: inTok, output_tokens: outTok },
        };
        return c.json(response, 200, {
          "anthropic-version": "2023-06-01",
          "X-Bridge-Route": "openai",
        });
      }
    } catch (err) {
      if (!shouldFallbackToLegacy(err)) throw err;
      console.warn("Anthropic native call failed, using legacy ReAct:", (err as Error).message);
    }
  }

  try {
    if (stream) {
      const streamBody = await callChatStream(apiKey, payload);
      const encoder = new TextEncoder();
      const inputTokens = calculateTokens(prompt);

      return new Response(
        new ReadableStream({
          async start(controller) {
            const reader = streamBody.getReader();
            const decoder = new TextDecoder();

            // Send message_start event
            writeAnthropicSSE(controller, encoder, "message_start", {
              type: "message_start",
              message: {
                id: messageId,
                type: "message",
                role: "assistant",
                content: [],
                model: cleanModel,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: inputTokens,
                  output_tokens: 0,
                },
              },
            });

            // Send ping
            writeAnthropicSSE(controller, encoder, "ping", { type: "ping" });

            let buffer = "";
            let fullContent = "";
            let contentBlockStarted = false;

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed || trimmed.startsWith(":")) continue;

                  let textChunk: string | null = null;
                  if (trimmed.startsWith("data: ")) {
                    const data = trimmed.slice(6);
                    if (data === "[DONE]") continue;
                    try {
                      const parsed: unknown = JSON.parse(data);
                      if (typeof parsed === "string") {
                        textChunk = parsed;
                      } else if (
                        typeof parsed === "object" &&
                        parsed !== null &&
                        "content" in parsed
                      ) {
                        textChunk = String((parsed as { content: unknown }).content);
                      } else if (
                        typeof parsed === "object" &&
                        parsed !== null &&
                        "text" in parsed
                      ) {
                        textChunk = String((parsed as { text: unknown }).text);
                      }
                    } catch {
                      textChunk = data;
                    }
                  } else {
                    textChunk = trimmed;
                  }

                  if (textChunk && !ResponseSanitizer.isCrawlingStatus(textChunk)) {
                    fullContent += textChunk;

                    if (!hasTools) {
                      if (!contentBlockStarted) {
                        writeAnthropicSSE(controller, encoder, "content_block_start", {
                          type: "content_block_start",
                          index: 0,
                          content_block: { type: "text", text: "" },
                        });
                        contentBlockStarted = true;
                      }

                      writeAnthropicSSE(controller, encoder, "content_block_delta", {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: textChunk },
                      });
                    }
                  }
                }
              }

              // Process accumulated content for tools or sanitize text
              const outputTokens = calculateTokens(fullContent);
              const toolCalls = hasTools
                ? ToolCallingEmulator.parseResponseWithFallback(
                    fullContent,
                    tools as unknown as ToolDefinition[],
                    (t) => parseToolCalls(t),
                  )
                : null;

              if (toolCalls && toolCalls.length > 0) {
                for (let i = 0; i < toolCalls.length; i++) {
                  const tc = toolCalls[i]!;
                  const toolUseId = tc.id.startsWith("toolu_")
                    ? tc.id
                    : `toolu_${tc.id.replace(/^call_/, "")}`;

                  let parsedArgs: Record<string, unknown> = {};
                  try {
                    parsedArgs = JSON.parse(tc.function.arguments);
                  } catch {
                    parsedArgs = { raw: tc.function.arguments };
                  }

                  writeAnthropicSSE(controller, encoder, "content_block_start", {
                    type: "content_block_start",
                    index: i,
                    content_block: {
                      type: "tool_use",
                      id: toolUseId,
                      name: tc.function.name,
                      input: parsedArgs,
                    },
                  });

                  const argStr = tc.function.arguments ?? "";
                  if (argStr.length === 0) {
                    writeAnthropicSSE(controller, encoder, "content_block_delta", {
                      type: "content_block_delta",
                      index: i,
                      delta: { type: "input_json_delta", partial_json: "" },
                    });
                  } else {
                    for (let s = 0; s < argStr.length; s += 64) {
                      writeAnthropicSSE(controller, encoder, "content_block_delta", {
                        type: "content_block_delta",
                        index: i,
                        delta: {
                          type: "input_json_delta",
                          partial_json: argStr.slice(s, s + 64),
                        },
                      });
                    }
                  }

                  writeAnthropicSSE(controller, encoder, "content_block_stop", {
                    type: "content_block_stop",
                    index: i,
                  });
                }

                writeAnthropicSSE(controller, encoder, "message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "tool_use", stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                });
              } else {
                if (hasTools && !contentBlockStarted) {
                  const cleaned = ResponseSanitizer.cleanOutput(fullContent);
                  writeAnthropicSSE(controller, encoder, "content_block_start", {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  });
                  writeAnthropicSSE(controller, encoder, "content_block_delta", {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: cleaned },
                  });
                }

                writeAnthropicSSE(controller, encoder, "content_block_stop", {
                  type: "content_block_stop",
                  index: 0,
                });

                writeAnthropicSSE(controller, encoder, "message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                });
              }

              writeAnthropicSSE(controller, encoder, "message_stop", {
                type: "message_stop",
              });

              controller.close();
            } catch (err) {
              console.error("Anthropic streaming error:", err);
              controller.error(err);
            }
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "anthropic-version": "2023-06-01",
          },
        },
      );
    }

    // Non-streaming response
    const rawContent = await extractLegacyText(await callChat(apiKey, payload));

    const toolCalls = hasTools
      ? ToolCallingEmulator.parseResponseWithFallback(
          rawContent,
          tools as unknown as ToolDefinition[],
          (t) => parseToolCalls(t),
        )
      : null;

    const contentBlocks: AnthropicContentBlock[] = [];
    let stopReason: "end_turn" | "tool_use" = "end_turn";

    if (toolCalls && toolCalls.length > 0) {
      stopReason = "tool_use";
      for (const tc of toolCalls) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(tc.function.arguments);
        } catch {
          parsedInput = { raw: tc.function.arguments };
        }
        contentBlocks.push({
          type: "tool_use",
          id: tc.id.replace("call_", "toolu_"),
          name: tc.function.name,
          input: parsedInput,
        });
      }
    } else {
      const cleanContent = ResponseSanitizer.cleanOutput(rawContent);
      contentBlocks.push({
        type: "text",
        text: cleanContent,
      });
    }

    const inputTokens = calculateTokens(prompt);
    const outputTokens = calculateTokens(rawContent);

    const response: AnthropicMessageResponse = {
      id: messageId,
      type: "message",
      role: "assistant",
      content: contentBlocks,
      model: cleanModel,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    };

    return c.json(response, 200, {
      "anthropic-version": "2023-06-01",
    });
  } catch (err) {
    console.error("Anthropic message error:", err);
    throw err;
  }
});

export default app;
