// ============================================================================
// 1min-bridge — POST /v1/responses (OpenAI Structured Responses API)
// ============================================================================

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getModelData } from "../model-registry.js";
import {
  callFeature,
  callFeatureStream,
} from "../adapters/onemin.js";
import { invalidRequestError, modelNotFoundError, sendError } from "../errors.js";
import { ResponseSanitizer } from "../adapters/sanitizer.js";
import { calculateTokens } from "../utils/tokens.js";
import type {
  Env,
  ResponseRequest,
  ResponsesAPIResponse,
} from "../types.js";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Zod schema for Responses API
// ---------------------------------------------------------------------------

const responseInputItemSchema = z.object({
  type: z.string().optional(),
  role: z.string().optional(),
  content: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
});

const responseFormatSchema = z.object({
  type: z.enum(["text", "json_object", "json_schema"]),
  json_schema: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    })
    .optional(),
});

const responsesRequestSchema = z.object({
  model: z.string().min(1).optional(),
  input: z.union([z.string(), z.array(responseInputItemSchema)]).optional(),
  messages: z.array(z.record(z.string(), z.unknown())).optional(),
  instructions: z.string().optional(),
  response_format: responseFormatSchema.optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStructuredPrompt(
  input?: string | Array<{ role?: string; content?: unknown }>,
  messages?: Array<Record<string, unknown>>,
  instructions?: string,
  responseFormat?: { type: string; json_schema?: { schema: Record<string, unknown> } },
  reasoningEffort?: string,
): string {
  const parts: string[] = [];

  let systemInstructions = instructions ? instructions.trim() : "";

  if (responseFormat?.type === "json_schema" && responseFormat.json_schema?.schema) {
    const schemaStr = JSON.stringify(responseFormat.json_schema.schema);
    const schemaInstruction = `CRITICAL REQUIREMENT: You MUST respond ONLY with a valid JSON object strictly complying with this JSON Schema:\n${schemaStr}\nDo not wrap in markdown fences or add explanatory text. Output valid raw JSON only.`;
    systemInstructions = systemInstructions
      ? `${systemInstructions}\n\n${schemaInstruction}`
      : schemaInstruction;
  } else if (responseFormat?.type === "json_object") {
    const jsonInstruction = `CRITICAL REQUIREMENT: You MUST respond with a valid JSON object. Do not add conversational text.`;
    systemInstructions = systemInstructions
      ? `${systemInstructions}\n\n${jsonInstruction}`
      : jsonInstruction;
  }

  if (reasoningEffort) {
    const effortInstruction = `Reasoning intensity: ${reasoningEffort}. Provide thorough analysis.`;
    systemInstructions = systemInstructions
      ? `${systemInstructions}\n\n${effortInstruction}`
      : effortInstruction;
  }

  if (systemInstructions) {
    parts.push(`System: ${systemInstructions}`);
  }

  if (typeof input === "string") {
    parts.push(`Human: ${input}`);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const role = item.role === "assistant" ? "Assistant" : "Human";
      const content = ResponseSanitizer.unpackMemoryContent(item.content);
      parts.push(`${role}: ${content}`);
    }
  } else if (Array.isArray(messages)) {
    for (const m of messages) {
      const role =
        m.role === "system" || m.role === "developer"
          ? "System"
          : m.role === "assistant"
            ? "Assistant"
            : "Human";
      const content = ResponseSanitizer.unpackMemoryContent(m.content);
      parts.push(`${role}: ${content}`);
    }
  }

  return parts.join("\n\n");
}

function newResponseId(): string {
  return `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

app.post("/v1/responses", async (c) => {
  const apiKey = c.get("oneMinApiKey");

  let body: ResponseRequest;
  try {
    const raw = await c.req.json();
    body = responsesRequestSchema.parse(raw) as unknown as ResponseRequest;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return sendError(c, invalidRequestError(`Validation error: ${msg}`));
    }
    return sendError(c, invalidRequestError("Invalid JSON body"));
  }

  if (!body.input && (!body.messages || body.messages.length === 0)) {
    return sendError(
      c,
      invalidRequestError("Either 'input' or 'messages' field is required"),
    );
  }

  const rawModel = body.model || "gpt-4o";
  const webSearch = rawModel.endsWith(":online");
  const cleanModel = webSearch ? rawModel.slice(0, -7) : rawModel;

  const modelData = await getModelData();
  if (!modelData.chatModelIds.includes(cleanModel)) {
    return sendError(c, modelNotFoundError(rawModel));
  }

  const prompt = buildStructuredPrompt(
    body.input as string | Array<{ role?: string; content?: unknown }>,
    body.messages as unknown as Array<Record<string, unknown>>,
    body.instructions,
    body.response_format,
    body.reasoning_effort,
  );

  c.set("model", cleanModel);
  c.set("promptTokens", calculateTokens(prompt));

  const responseId = newResponseId();
  const created = nowSec();

  const payload = {
    type: "CHAT_WITH_AI",
    model: cleanModel,
    promptObject: {
      prompt,
      isMixed: false,
      webSearch,
      ...(body.max_output_tokens ? { maxTokens: body.max_output_tokens } : {}),
    },
  };

  try {
    if (body.stream) {
      const upstream = await callFeatureStream(apiKey, payload);
      const encoder = new TextEncoder();
      const promptTokens = calculateTokens(prompt);

      return new Response(
        new ReadableStream({
          async start(controller) {
            const reader = upstream.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let fullContent = "";

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
                      if (typeof parsed === "string") textChunk = parsed;
                      else if (typeof parsed === "object" && parsed !== null && "content" in parsed) {
                        textChunk = String((parsed as { content: unknown }).content);
                      }
                    } catch {
                      textChunk = data;
                    }
                  } else {
                    textChunk = trimmed;
                  }

                  if (textChunk) {
                    fullContent += textChunk;
                    const chunkData = {
                      id: responseId,
                      object: "response.chunk",
                      created,
                      model: cleanModel,
                      output: [
                        {
                          index: 0,
                          delta: {
                            content: [{ type: "text", text: textChunk }],
                          },
                        },
                      ],
                    };
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`),
                    );
                  }
                }
              }

              const completionTokens = calculateTokens(fullContent);
              const doneChunk = {
                id: responseId,
                object: "response.chunk",
                created,
                model: cleanModel,
                status: "completed",
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: promptTokens + completionTokens,
                },
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch (err) {
              console.error("Responses streaming error:", err);
              controller.error(err);
            }
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    }

    // Non-streaming
    const data = await callFeature(apiKey, payload);
    const resultObj = data.aiRecord?.aiRecordDetail?.resultObject;
    let rawContent = "";
    if (typeof resultObj === "string") {
      rawContent = resultObj;
    } else if (Array.isArray(resultObj) && typeof resultObj[0] === "string") {
      rawContent = resultObj[0];
    } else if (resultObj && typeof resultObj === "object") {
      rawContent = JSON.stringify(resultObj);
    }

    const cleanContent = ResponseSanitizer.cleanOutput(rawContent);
    const promptTokens = calculateTokens(prompt);
    const completionTokens = calculateTokens(rawContent);

    const response: ResponsesAPIResponse = {
      id: responseId,
      object: "response",
      created,
      model: cleanModel,
      status: "completed",
      output: [
        {
          id: `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "text",
              text: cleanContent,
            },
          ],
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    return c.json(response);
  } catch (err) {
    console.error("Responses API error:", err);
    throw err;
  }
});

export default app;
