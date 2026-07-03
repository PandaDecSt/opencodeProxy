// Internal unified format - format-agnostic types

export type MessageRole = "user" | "assistant" | "tool"

export interface TextPart {
  type: "text"
  text: string
}

export interface ReasoningPart {
  type: "reasoning"
  text: string
}

export interface ToolUsePart {
  type: "tool_use"
  toolCallId: string
  toolName: string
  input: any
}

export interface ToolResultPart {
  type: "tool_result"
  toolCallId: string
  toolName?: string
  output: any
}

export type ContentPart = TextPart | ReasoningPart | ToolUsePart | ToolResultPart

export interface InternalMessage {
  role: MessageRole
  content: string | ContentPart[]
  toolCallId?: string
}

export interface InternalTool {
  name: string
  description?: string
  inputSchema: any
}

export interface InternalRequest {
  model: string
  messages: InternalMessage[]
  system?: string | SystemBlock[]
  tools?: InternalTool[]
  temperature?: number
  topP?: number
  maxTokens?: number
  stream?: boolean
  stop?: string[]
  presencePenalty?: number
  frequencyPenalty?: number
  seed?: number
  // Metadata
  request?: any // Original request for context
}

export interface SystemBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral" }
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface InternalResponse {
  id: string
  model: string
  content: ContentPart[]
  finishReason: string
  usage: Usage
}

export interface StreamChunk {
  type: "text" | "reasoning" | "tool_use" | "tool_result" | "done"
  text?: string
  toolCallId?: string
  toolName?: string
  input?: any
  finishReason?: string
  usage?: Usage
}

// Format adapter interface
export interface FormatAdapter {
  name: string
  
  // Register routes for this format
  registerRoutes(router: any, handler: (req: any, res: any, body: any) => Promise<void>): void
  
  // Parse external request → internal format
  parseRequest(body: any, params?: Record<string, string>): InternalRequest
  
  // Internal response → external format
  formatResponse(response: InternalResponse, req?: any): any
  
  // Stream chunk conversion
  formatStreamChunk?(chunk: StreamChunk, context: any): any
  
  // Stream done
  formatStreamDone?(context: any): any
  
  // Error format
  formatError?(error: any): any
}

// Request handler type
export type RequestHandler = (request: InternalRequest) => Promise<InternalResponse>
