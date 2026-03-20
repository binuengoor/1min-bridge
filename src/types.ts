// ============================================================================
// 1min-relay — Type Definitions
// ============================================================================

// ---------------------------------------------------------------------------
// 1min.ai API types
// ---------------------------------------------------------------------------

/** Raw model entry from GET /models?feature=... */
export interface OneMinModelEntry {
  uuid: string;
  modelId: string;
  name: string;
  group: string;
  provider: string;
  status: string;
  features: string[];
  creditMetadata: {
    INPUT?: number;
    OUTPUT?: number;
    CONTEXT?: number;
    MAX_OUTPUT_TOKEN?: number;
    LOW_IMAGE?: number;
    [key: string]: unknown;
  };
  modality: {
    INPUT: string[];
    OUTPUT: string[];
  } | null;
}

/** Shape of the /models API response */
export interface OneMinModelsResponse {
  models: OneMinModelEntry[];
  total: number;
}

/** 1min.ai /api/features request body */
export interface OneMinRequestBody {
  type: string;
  model: string;
  promptObject: Record<string, unknown>;
}

/** 1min.ai /api/features response (non-streaming) */
export interface OneMinResponse {
  aiRecord?: {
    aiRecordDetail?: {
      resultObject?: unknown;
    };
  };
}

/** 1min.ai /api/assets upload response */
export interface OneMinAssetResponse {
  url?: string;
  path?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal cached model data
// ---------------------------------------------------------------------------

export interface CachedModelData {
  chatModelIds: string[];
  imageModelIds: string[];
  visionModelIds: string[];
  speechModelIds: string[];
  entries: OneMinModelEntry[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible request/response types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool" | "function";
  content: string | ChatContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
  response_format?: { type: string };
  user?: string;
}

export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
}

export interface OpenAIModel {
  id: string;
  object: "model";
  name?: string;
  created: number;
  owned_by: string;
  // Enriched fields (OpenRouter-compatible)
  context_length?: number;
  architecture?: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
  };
  top_provider?: {
    context_length: number;
    max_completion_tokens: number | null;
  };
  supported_parameters?: string[];
  pricing?: {
    prompt: string;
    completion: string;
    unit: string;
  };
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
  logprobs?: null;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: { role?: "assistant"; content?: string | null; tool_calls?: ToolCall[] };
  finish_reason: string | null;
  logprobs?: null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: UsageInfo;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface ImageData {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: ImageData[];
}

export interface TranscriptionResponse {
  text: string;
}

// ---------------------------------------------------------------------------
// Application config
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  oneMinApiUrl: string;
  oneMinStreamingUrl: string;
  oneMinModelsUrl: string;
  oneMinAssetUrl: string;
  cacheTtlMs: number;
  allowedModels?: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  logFormat: "text" | "json";
  defaultApiKey?: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Hono context variables
// ---------------------------------------------------------------------------

export type Env = {
  Variables: {
    oneMinApiKey: string;
  };
};

// Tool calling types
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}
