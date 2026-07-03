import { LanguageModel } from "ai"

export interface ChatCompletionRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }
  parallel_tool_calls?: boolean
  n?: number
  stop?: string | string[]
  presence_penalty?: number
  frequency_penalty?: number
  logprobs?: boolean
  top_logprobs?: number
  response_format?: { type: "text" | "json_object" }
  seed?: number
  user?: string
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | OpenAIContentPart[]
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIContentPart {
  type: "text" | "image_url"
  text?: string
  image_url?: { url: string; detail?: "auto" | "low" | "high" }
}

export interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface OpenAITool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ChatCompletionChoice {
  index: number
  message: OpenAIMessage
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: ChatCompletionChunkChoice[]
}

export interface ChatCompletionChunkChoice {
  index: number
  delta: {
    role?: "assistant"
    content?: string
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

export interface ModelsResponse {
  object: "list"
  data: ModelData[]
}

export interface ModelData {
  id: string
  object: "model"
  created: number
  owned_by: string
}

export interface ModelMapping {
  externalId: string
  providerId: string
  modelId: string
  displayName?: string
}

/** 代理配置 */
export interface ProxyConfig {
  port?: number
  host?: string
  modelMappings: ModelMapping[]
  defaultModel?: string
  requestTimeout?: number
  maxTokens?: number
  adminApiKey?: string
}

/** 默认模型映射 - 可通过配置文件覆盖 */
export const DEFAULT_MODEL_MAPPINGS: ModelMapping[] = [
  { externalId: "free-claude", providerId: "anthropic", modelId: "claude-3-5-haiku-20241022", displayName: "Claude 3.5 Haiku (Free)" },
  { externalId: "free-gpt4o-mini", providerId: "openai", modelId: "gpt-4o-mini", displayName: "GPT-4o Mini (Free tier)" },
  { externalId: "free-gemini-flash", providerId: "google", modelId: "gemini-1.5-flash", displayName: "Gemini 1.5 Flash (Free)" },
  { externalId: "free-deepseek", providerId: "deepseek", modelId: "deepseek-chat", displayName: "DeepSeek Chat (Free)" },
]

/** 根据外部 model ID 查找映射 */
export function findModelMapping(externalId: string, mappings: ModelMapping[] = DEFAULT_MODEL_MAPPINGS): ModelMapping | undefined {
  return mappings.find((m) => m.externalId === externalId)
}

/** 解析 OpenAI tool_choice 参数 */
export function parseToolChoice(toolChoice?: ChatCompletionRequest["tool_choice"]): "auto" | "none" | "required" | { function: { name: string } } {
  if (!toolChoice || toolChoice === "auto") return "auto"
  if (toolChoice === "none") return "none"
  if (toolChoice === "required") return "required"
  return { function: { name: toolChoice.function.name } }
}

/** 生成 OpenAI 兼容的响应 ID */
export function generateId(prefix = "chatcmpl"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

/** 创建非流式响应 */
export function createChatCompletionResponse(
  model: string,
  message: OpenAIMessage,
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
  usage?: { promptTokens: number; completionTokens: number }
): ChatCompletionResponse {
  return {
    id: generateId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
        }
      : undefined,
  }
}

/** 创建流式响应 chunk */
export function createChatCompletionChunk(
  model: string,
  delta: ChatCompletionChunk["choices"][0]["delta"],
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null
): ChatCompletionChunk {
  return {
    id: generateId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** 创建模型列表响应 */
export function createModelsResponse(mappings: ModelMapping[]): ModelsResponse {
  return {
    object: "list",
    data: mappings.map((m) => ({
      id: m.externalId,
      object: "model" as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: m.providerId,
    })),
  }
}