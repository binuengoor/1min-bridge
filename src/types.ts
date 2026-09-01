// ============================================================================
// 1min-bridge — Type Definitions
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

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
  response_format?: { type: string; json_schema?: Record<string, unknown> };
  stream_options?: { include_usage?: boolean };
  user?: string;
  tools?: ChatTool[];
  tool_choice?:
    | "auto"
    | "required"
    | "none"
    | {
        type: "function";
        function: { name: string };
      };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
  logprobs?: null;
}

export interface StreamingToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: (ToolCall | StreamingToolCall)[];
  };
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
  usage?: UsageInfo | null;
}

export interface OpenAIModel {
  id: string;
  object: "model";
  name?: string;
  created: number;
  owned_by: string;
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

export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  output_format?: "png" | "jpeg" | "webp";
  output_quality?: number;
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
  [key: string]: unknown;
}

export interface AudioSpeechRequest {
  model: string;
  input: string;
  voice: string;
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  speed?: number;
  speakingRate?: number;
  pitch?: number;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API types
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens: number;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// OpenAI Structured Responses API types
// ---------------------------------------------------------------------------

export interface ResponseInputItem {
  type?: string;
  role?: string;
  content?: string | ChatContentPart[];
}

export interface ResponseRequest {
  model?: string;
  input?: string | ResponseInputItem[];
  messages?: ChatMessage[];
  instructions?: string;
  response_format?: {
    type: "text" | "json_object" | "json_schema";
    json_schema?: {
      name: string;
      description?: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
  reasoning_effort?: "low" | "medium" | "high";
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
}

export interface ResponsesOutputMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{
    type: "text";
    text: string;
  }>;
}

export interface ResponsesAPIResponse {
  id: string;
  object: "response";
  created: number;
  model: string;
  status: "completed" | "in_progress" | "incomplete";
  output: ResponsesOutputMessage[];
  usage: UsageInfo;
}

// ---------------------------------------------------------------------------
// Web Search & Fetch types
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  limit?: number;
  categories?: string;
}

export interface WebFetchRequest {
  url: string;
}

// ---------------------------------------------------------------------------
// Application config & Env
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  oneMinApiUrl: string;
  oneMinStreamingUrl: string;
  oneMinChatApiUrl: string;
  oneMinChatStreamingUrl: string;
  oneMinModelsUrl: string;
  oneMinAssetUrl: string;
  cacheTtlMs: number;
  allowedModels?: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  logFormat: "text" | "json";
  defaultApiKey?: string;
  searxngUrl?: string;
  searxngSecret?: string;
  checkin: CheckinConfig;
}

// ---------------------------------------------------------------------------
// Daily Check-in types
// ---------------------------------------------------------------------------

export interface CheckinConfig {
  enabled: boolean;
  email?: string;
  password?: string;
  totpSecret?: string;
  onStartup: boolean;
  utcHour: number; // 0-23 (default 8 UTC = 00:00 PST)
  jitterMinutes: number; // 0-30 (default 10)
  telegramBotToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
}

export interface CheckinResult {
  success: boolean;
  timestamp: string;
  userName?: string;
  teamId?: string;
  initialCredit?: number;
  finalCredit?: number;
  creditDiff?: number;
  availablePercent?: string;
  error?: string;
  attemptCount?: number;
  manual?: boolean;
}

export interface CheckinStatus {
  enabled: boolean;
  isConfigured: boolean;
  lastRun?: CheckinResult;
  nextScheduledRun?: string;
  currentBalance?: number;
  totalCheckins: number;
  successfulCheckins: number;
  history: CheckinResult[];
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}

export interface CloudflareKV {
  get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<any>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export type Env = {
  Bindings?: {
    RATE_LIMIT_STORE?: CloudflareKV;
    MODEL_CACHE?: CloudflareKV;
    AUTH_TOKEN?: string;
    ONE_MIN_API_KEY?: string;
    ONE_MIN_CHAT_API_URL?: string;
    SEARXNG_URL?: string;
    SEARXNG_SECRET?: string;
  };
  Variables: {
    oneMinApiKey: string;
    gatewayToken?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    credits?: number;
  };
};
