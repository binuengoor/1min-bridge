// ============================================================================
// 1min-bridge — OpenAPI 3.1.0 Specification
// ============================================================================

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "1min-bridge API",
    description:
      "Self-hosted OpenAI-compatible relay for 1min.ai with automatic model discovery. Drop-in replacement for the OpenAI API — supports chat completions (streaming + vision + tool calling), image generation, audio transcription/translation, and YouTube summarization.",
    version: "0.1.0",
    license: {
      name: "MIT",
    },
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development",
    },
  ],
  tags: [
    { name: "Health", description: "Server health and status" },
    { name: "Models", description: "List and inspect available models" },
    { name: "Chat", description: "Chat completions with streaming, vision, and tool calling" },
    { name: "Images", description: "Image generation" },
    { name: "Audio", description: "Speech-to-text and audio translation" },
    { name: "YouTube", description: "YouTube video summarization" },
    { name: "Docs", description: "API documentation" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        description: "Returns server health status and model registry statistics.",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    models: {
                      type: "object",
                      properties: {
                        chat: { type: "integer", example: 85 },
                        image: { type: "integer", example: 15 },
                        speech: { type: "integer", example: 12 },
                        total: { type: "integer", example: 112 },
                      },
                    },
                    cacheAge: {
                      type: "integer",
                      description: "Seconds since model cache was last refreshed",
                      example: 42,
                    },
                  },
                },
              },
            },
          },
          "503": {
            description: "Model registry unavailable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/v1/models": {
      get: {
        tags: ["Models"],
        summary: "List models",
        description:
          "Returns all available models with OpenRouter-compatible enrichment fields (context_length, architecture, supported_parameters, pricing).",
        operationId: "listModels",
        responses: {
          "200": {
            description: "List of models",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string", example: "list" },
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Model" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/models/{modelId}": {
      get: {
        tags: ["Models"],
        summary: "Retrieve model",
        description: "Returns a specific model by ID.",
        operationId: "getModel",
        parameters: [
          {
            name: "modelId",
            in: "path",
            required: true,
            schema: { type: "string" },
            example: "gpt-4o",
          },
        ],
        responses: {
          "200": {
            description: "Model details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Model" },
              },
            },
          },
          "404": {
            description: "Model not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        tags: ["Chat"],
        summary: "Create chat completion",
        description:
          "Creates a chat completion. Supports streaming (SSE), vision (image_url), tool calling, and model suffix feature routing (`:online`, `:pdf`, `:summarize`, `:code`).",
        operationId: "createChatCompletion",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChatCompletionRequest" },
              examples: {
                basic: {
                  summary: "Basic chat completion",
                  value: {
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "Hello!" }],
                  },
                },
                streaming: {
                  summary: "Streaming chat completion",
                  value: {
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "Count to 5" }],
                    stream: true,
                  },
                },
                vision: {
                  summary: "Vision (image input)",
                  value: {
                    model: "gpt-4o",
                    messages: [
                      {
                        role: "user",
                        content: [
                          { type: "text", text: "What is in this image?" },
                          {
                            type: "image_url",
                            image_url: { url: "https://example.com/photo.jpg" },
                          },
                        ],
                      },
                    ],
                  },
                },
                toolCalling: {
                  summary: "Tool calling",
                  value: {
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
                    tools: [
                      {
                        type: "function",
                        function: {
                          name: "get_weather",
                          description: "Get weather for a city",
                          parameters: {
                            type: "object",
                            properties: { city: { type: "string" } },
                            required: ["city"],
                          },
                        },
                      },
                    ],
                    tool_choice: "auto",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Chat completion (non-streaming)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatCompletionResponse" },
              },
            },
          },
          "200_streaming": {
            description: "Chat completion (streaming SSE)",
            content: {
              "text/event-stream": {
                schema: {
                  type: "string",
                  description:
                    'Server-Sent Events. Each `data:` line contains a ChatCompletionChunk JSON object. Ends with `data: [DONE]`.',
                },
              },
            },
          },
          "400": {
            description: "Invalid request or validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "401": {
            description: "Unauthorized — missing or invalid API key",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "429": {
            description: "Rate limit exceeded",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/v1/images/generations": {
      post: {
        tags: ["Images"],
        summary: "Generate images",
        description: "Creates images from a text prompt using any supported image model.",
        operationId: "createImage",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ImageGenerationRequest" },
              examples: {
                default: {
                  summary: "Generate an image",
                  value: {
                    model: "flux-schnell",
                    prompt: "a cat wearing a space suit, photorealistic",
                    n: 1,
                    size: "1024x1024",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Generated images",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ImageGenerationResponse" },
              },
            },
          },
          "400": {
            description: "Invalid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "401": {
            description: "Unauthorized",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/v1/audio/transcriptions": {
      post: {
        tags: ["Audio"],
        summary: "Transcribe audio",
        description: "Transcribes audio into text using Whisper or other speech-to-text models.",
        operationId: "createTranscription",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: {
                    type: "string",
                    format: "binary",
                    description: "Audio file (mp3, wav, ogg, m4a, webm)",
                  },
                  model: {
                    type: "string",
                    default: "whisper-1",
                    description: "Speech-to-text model",
                  },
                  language: {
                    type: "string",
                    description: "ISO-639-1 language code (e.g. 'en', 'fr')",
                  },
                  response_format: {
                    type: "string",
                    enum: ["json", "text"],
                    default: "json",
                  },
                  prompt: {
                    type: "string",
                    description: "Optional prompt for context",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Transcription result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TranscriptionResponse" },
              },
              "text/plain": {
                schema: { type: "string" },
              },
            },
          },
          "400": {
            description: "Invalid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/v1/audio/translations": {
      post: {
        tags: ["Audio"],
        summary: "Translate audio to English",
        description: "Translates audio into English text.",
        operationId: "createTranslation",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: {
                    type: "string",
                    format: "binary",
                    description: "Audio file (any language)",
                  },
                  model: {
                    type: "string",
                    default: "whisper-1",
                  },
                  response_format: {
                    type: "string",
                    enum: ["json", "text"],
                    default: "json",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Translation result (English)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TranscriptionResponse" },
              },
              "text/plain": {
                schema: { type: "string" },
              },
            },
          },
        },
      },
    },
    "/v1/engines/youtube/summarize": {
      post: {
        tags: ["YouTube"],
        summary: "Summarize YouTube video",
        description: "Summarizes a YouTube video given its URL.",
        operationId: "summarizeYoutube",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: {
                    type: "string",
                    format: "uri",
                    description: "YouTube video URL",
                    example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Video summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    text: { type: "string", description: "Summary text" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Your 1min.ai API key, passed as a Bearer token.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              message: { type: "string" },
              type: { type: "string" },
              param: { type: "string", nullable: true },
              code: { type: "string", nullable: true },
            },
            required: ["message", "type"],
          },
        },
      },
      Model: {
        type: "object",
        properties: {
          id: { type: "string", example: "gpt-4o" },
          object: { type: "string", example: "model" },
          name: { type: "string", example: "GPT-4o" },
          created: { type: "integer", example: 1710000000 },
          owned_by: { type: "string", example: "openai" },
          context_length: { type: "integer", example: 128000 },
          architecture: {
            type: "object",
            properties: {
              modality: { type: "string", example: "text+image->text" },
              input_modalities: {
                type: "array",
                items: { type: "string" },
                example: ["text", "image"],
              },
              output_modalities: {
                type: "array",
                items: { type: "string" },
                example: ["text"],
              },
            },
          },
          top_provider: {
            type: "object",
            properties: {
              context_length: { type: "integer" },
              max_completion_tokens: { type: "integer", nullable: true },
            },
          },
          supported_parameters: {
            type: "array",
            items: { type: "string" },
            example: ["max_tokens", "temperature", "top_p", "tools"],
          },
          pricing: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              completion: { type: "string" },
              unit: { type: "string", example: "credits_per_token" },
            },
          },
        },
        required: ["id", "object", "created", "owned_by"],
      },
      ChatMessage: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: ["system", "user", "assistant", "tool"],
          },
          content: {
            oneOf: [
              { type: "string" },
              {
                type: "array",
                items: { $ref: "#/components/schemas/ContentPart" },
              },
            ],
          },
          name: { type: "string" },
          tool_calls: {
            type: "array",
            items: { $ref: "#/components/schemas/ToolCall" },
          },
          tool_call_id: { type: "string" },
        },
        required: ["role", "content"],
      },
      ContentPart: {
        oneOf: [
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["text"] },
              text: { type: "string" },
            },
            required: ["type", "text"],
          },
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["image_url"] },
              image_url: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  detail: { type: "string", enum: ["low", "high", "auto"] },
                },
                required: ["url"],
              },
            },
            required: ["type", "image_url"],
          },
        ],
      },
      Tool: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["function"] },
          function: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              parameters: { type: "object" },
            },
            required: ["name"],
          },
        },
        required: ["type", "function"],
      },
      ToolCall: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["function"] },
          function: {
            type: "object",
            properties: {
              name: { type: "string" },
              arguments: { type: "string" },
            },
            required: ["name", "arguments"],
          },
        },
        required: ["id", "type", "function"],
      },
      ChatCompletionRequest: {
        type: "object",
        required: ["model", "messages"],
        properties: {
          model: {
            type: "string",
            description: "Model ID. Supports suffixes: :online, :pdf, :summarize, :code",
            example: "gpt-4o",
          },
          messages: {
            type: "array",
            items: { $ref: "#/components/schemas/ChatMessage" },
            minItems: 1,
          },
          stream: { type: "boolean", default: false },
          temperature: { type: "number", minimum: 0, maximum: 2 },
          max_tokens: { type: "integer", minimum: 1 },
          top_p: { type: "number", minimum: 0, maximum: 1 },
          frequency_penalty: { type: "number", minimum: -2, maximum: 2 },
          presence_penalty: { type: "number", minimum: -2, maximum: 2 },
          stop: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          n: { type: "integer", minimum: 1, maximum: 4 },
          response_format: {
            type: "object",
            properties: { type: { type: "string" } },
          },
          user: { type: "string" },
          tools: {
            type: "array",
            items: { $ref: "#/components/schemas/Tool" },
          },
          tool_choice: {
            oneOf: [
              { type: "string", enum: ["auto", "required", "none"] },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["function"] },
                  function: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                  },
                },
                required: ["type", "function"],
              },
            ],
          },
        },
      },
      ChatCompletionResponse: {
        type: "object",
        properties: {
          id: { type: "string", example: "chatcmpl-a1b2c3d4" },
          object: { type: "string", example: "chat.completion" },
          created: { type: "integer" },
          model: { type: "string" },
          choices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                message: {
                  type: "object",
                  properties: {
                    role: { type: "string", example: "assistant" },
                    content: { type: "string", nullable: true },
                    tool_calls: {
                      type: "array",
                      items: { $ref: "#/components/schemas/ToolCall" },
                    },
                  },
                },
                finish_reason: { type: "string", example: "stop" },
              },
            },
          },
          usage: {
            type: "object",
            properties: {
              prompt_tokens: { type: "integer" },
              completion_tokens: { type: "integer" },
              total_tokens: { type: "integer" },
            },
          },
        },
      },
      ImageGenerationRequest: {
        type: "object",
        required: ["prompt"],
        properties: {
          model: { type: "string", default: "flux-schnell" },
          prompt: { type: "string", example: "a sunset over mountains" },
          n: { type: "integer", minimum: 1, maximum: 10, default: 1 },
          size: { type: "string", default: "1024x1024" },
          response_format: { type: "string", enum: ["url", "b64_json"], default: "url" },
          quality: { type: "string", enum: ["standard", "hd"] },
          style: { type: "string", enum: ["vivid", "natural"] },
        },
      },
      ImageGenerationResponse: {
        type: "object",
        properties: {
          created: { type: "integer" },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                b64_json: { type: "string" },
                revised_prompt: { type: "string" },
              },
            },
          },
        },
      },
      TranscriptionResponse: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
      },
    },
  },
} as const;
