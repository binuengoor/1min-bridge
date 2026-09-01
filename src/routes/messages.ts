// ============================================================================
// 1min-bridge — POST /v1/messages (Anthropic Messages API Compatibility)
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getModelData } from "../model-registry.js";
import {
  callChat,
  callChatStream,
} from "../adapters/onemin.js";
import { invalidRequestError, modelNotFoundError, sendError } from "../errors.js";
import {
  ToolCallingEmulator,
  type ToolDefinition,
} from "../adapters/tool-emulator.js";
import { ResponseSanitizer } from "../adapters/sanitizer.js";
import { calculateTokens } from "../utils/tokens.js";
import type {
  Env,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicContentBlock,
  ChatMessage,
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
        ? `[Contexto do Sistema - Informação Recuperada para ${m.tool_call_id}]:`
        : `[Contexto do Sistema - Informação Recuperada]:`;
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
      parts.push(`[Assistente consultou: ${callsStr}]`);
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

  const payload = {
    type: "UNIFY_CHAT_WITH_AI",
    model: cleanModel,
    promptObject: {
      prompt,
      isMixed: false,
      webSearch,
      ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
    },
  };

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

                  if (textChunk) {
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
                ? ToolCallingEmulator.parseResponse(
                    fullContent,
                    tools as unknown as ToolDefinition[],
                  )
                : null;

              if (toolCalls && toolCalls.length > 0) {
                for (let i = 0; i < toolCalls.length; i++) {
                  const tc = toolCalls[i]!;
                  const toolUseId = tc.id.replace("call_", "toolu_");

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

                  writeAnthropicSSE(controller, encoder, "content_block_delta", {
                    type: "content_block_delta",
                    index: i,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments,
                    },
                  });

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
    const data = await callChat(apiKey, payload);
    const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
    let rawContent = "";
    if (typeof resultObj === "string") {
      rawContent = resultObj;
    } else if (Array.isArray(resultObj) && typeof resultObj[0] === "string") {
      rawContent = resultObj[0];
    } else if (resultObj && typeof resultObj === "object") {
      rawContent = JSON.stringify(resultObj);
    }

    const toolCalls = hasTools
      ? ToolCallingEmulator.parseResponse(
          rawContent,
          tools as unknown as ToolDefinition[],
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
