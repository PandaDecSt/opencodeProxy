import type { Router } from "../router.js"
import type {
  FormatAdapter,
  InternalRequest,
  InternalResponse,
  InternalMessage,
  InternalTool,
  ContentPart,
  StreamChunk,
} from "../core/types.js"
import { parseBody, sendJson, sendError } from "../utils.js"
import { getLogManager } from "../log-config.js"
import { createRequestLogger } from "../logger.js"
import type { ProxyConfig } from "../types.js"

export class OpenAIAdapter implements FormatAdapter {
  name = "openai"

  constructor(private config: ProxyConfig) {}

  registerRoutes(router: Router, handler: (req: any, res: any, body: any) => Promise<void>) {
    const manager = getLogManager()

    // POST /v1/chat/completions
    router.post("/v1/chat/completions", async ({ req, res }) => {
      const body = await parseBody(req)
      
      // Validate messages
      if (!body.messages || !Array.isArray(body.messages)) {
        return sendError(res, 400, "messages array is required")
      }

      // Validate temperature
      if (body.temperature !== undefined) {
        if (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2) {
          return sendError(res, 400, "temperature must be a number between 0 and 2")
        }
      }

      // Validate top_p
      if (body.top_p !== undefined) {
        if (typeof body.top_p !== "number" || body.top_p < 0 || body.top_p > 1) {
          return sendError(res, 400, "top_p must be a number between 0 and 1")
        }
      }

      // Validate max_tokens
      if (body.max_tokens !== undefined) {
        if (typeof body.max_tokens !== "number" || body.max_tokens < 1) {
          return sendError(res, 400, "max_tokens must be a positive integer")
        }
      }

      // Log
      if (manager.shouldLog("request")) {
        const logger = createRequestLogger("POST", "/v1/chat/completions")
        logger.logRequest(body)
        ;(req as any)._logger = logger
      }

      await handler(req, res, body)
    })

    // GET /v1/models
    router.get("/v1/models", async ({ req, res }) => {
      await handler(req, res, null)
    })
  }

  parseRequest(body: any): InternalRequest {
    const messages: InternalMessage[] = []

    for (const msg of body.messages || []) {
      if (msg.role === "system") {
        // System messages handled separately
        continue
      }

      if (msg.role === "tool") {
        messages.push({
          role: "tool",
          content: msg.content,
          toolCallId: msg.tool_call_id,
        })
        continue
      }

      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const content: ContentPart[] = []
        
        // Add reasoning if present
        if (msg.reasoning && Array.isArray(msg.reasoning)) {
          for (const r of msg.reasoning) {
            content.push({ type: "reasoning", text: r.text || "" })
          }
        }

        // Add text
        if (msg.content) {
          content.push({ type: "text", text: msg.content })
        }

        // Add tool calls
        for (const tc of msg.tool_calls) {
          let input = {}
          try {
            input = JSON.parse(tc.function.arguments)
          } catch {}
          content.push({
            type: "tool_use",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input,
          })
        }

        messages.push({ role: "assistant", content })
        continue
      }

      // Regular user/assistant message
      messages.push({
        role: msg.role,
        content: msg.content,
      })
    }

    // Extract system messages
    const systemMessages = (body.messages || [])
      .filter((m: any) => m.role === "system")
      .map((m: any) => m.content)
      .join("\n")

    // Convert tools
    const tools: InternalTool[] | undefined = body.tools?.map((t: any) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters || {},
    }))

    return {
      model: body.model || this.config.defaultModel,
      messages,
      system: systemMessages || undefined,
      tools,
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_tokens,
      stream: body.stream,
      stop: body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined,
      presencePenalty: body.presence_penalty,
      frequencyPenalty: body.frequency_penalty,
      seed: body.seed,
    }
  }

  formatResponse(response: InternalResponse, req?: any): any {
    const message: any = {
      role: "assistant",
      content: "",
    }

    // Extract text content
    const textPart = response.content.find(c => c.type === "text")
    if (textPart && "text" in textPart) {
      message.content = textPart.text
    }

    // Extract reasoning
    const reasoningParts = response.content.filter(c => c.type === "reasoning")
    if (reasoningParts.length > 0) {
      message.reasoning = reasoningParts.map(r => ({
        type: "reasoning",
        text: "text" in r ? r.text : "",
      }))
    }

    // Extract tool calls
    const toolUseParts = response.content.filter(c => c.type === "tool_use")
    if (toolUseParts.length > 0) {
      message.tool_calls = toolUseParts.map(tc => ({
        id: "toolCallId" in tc ? tc.toolCallId : "",
        type: "function",
        function: {
          name: "toolName" in tc ? tc.toolName : "",
          arguments: JSON.stringify("input" in tc ? tc.input : {}),
        },
      }))
    }

    // Map finish reason
    const finishReason = response.finishReason === "tool_use" ? "tool_calls" : "stop"

    return {
      id: response.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: response.usage.inputTokens,
        completion_tokens: response.usage.outputTokens,
        total_tokens: response.usage.totalTokens,
      },
    }
  }

  formatStreamChunk(chunk: StreamChunk, context: { completionId: string; created: number; model: string }): any {
    if (chunk.type === "text") {
      return {
        id: context.completionId,
        object: "chat.completion.chunk",
        created: context.created,
        model: context.model,
        choices: [{
          index: 0,
          delta: { content: chunk.text },
          finish_reason: null,
        }],
      }
    }

    if (chunk.type === "reasoning") {
      return {
        id: context.completionId,
        object: "chat.completion.chunk",
        created: context.created,
        model: context.model,
        choices: [{
          index: 0,
          delta: { reasoning: [{ type: "reasoning", text: chunk.text }] },
          finish_reason: null,
        }],
      }
    }

    if (chunk.type === "tool_use") {
      return {
        id: context.completionId,
        object: "chat.completion.chunk",
        created: context.created,
        model: context.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: chunk.toolCallId,
              type: "function",
              function: {
                name: chunk.toolName,
                arguments: JSON.stringify(chunk.input || {}),
              },
            }],
          },
          finish_reason: null,
        }],
      }
    }

    if (chunk.type === "done") {
      return {
        id: context.completionId,
        object: "chat.completion.chunk",
        created: context.created,
        model: context.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: chunk.finishReason === "tool_use" ? "tool_calls" : "stop",
        }],
        usage: chunk.usage ? {
          prompt_tokens: chunk.usage.inputTokens,
          completion_tokens: chunk.usage.outputTokens,
          total_tokens: chunk.usage.totalTokens,
        } : undefined,
      }
    }

    return null
  }

  formatError(error: any): any {
    return {
      error: {
        message: String(error),
        type: "api_error",
        code: 500,
      },
    }
  }
}
