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

export class AnthropicAdapter implements FormatAdapter {
  name = "anthropic"
  private streamState = new Map<any, { blockIndex: number; currentType: string | null }>()

  constructor(private config: ProxyConfig) {}

  registerRoutes(router: Router, handler: (req: any, res: any, body: any) => Promise<void>) {
    const manager = getLogManager()

    // POST /v1/messages
    router.post("/v1/messages", async ({ req, res }) => {
      const body = await parseBody(req)

      // Validate messages
      if (!body.messages || !Array.isArray(body.messages)) {
        return sendError(res, 400, "messages array is required", {
          type: "invalid_request_error",
        })
      }
      if (!body.max_tokens) {
        return sendError(res, 400, "max_tokens is required", {
          type: "invalid_request_error",
        })
      }

      // Validate temperature
      if (body.temperature !== undefined) {
        if (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 1) {
          return sendError(res, 400, "temperature must be a number between 0 and 1")
        }
      }

      // Validate top_p
      if (body.top_p !== undefined) {
        if (typeof body.top_p !== "number" || body.top_p < 0 || body.top_p > 1) {
          return sendError(res, 400, "top_p must be a number between 0 and 1")
        }
      }

      // Validate max_tokens
      if (typeof body.max_tokens !== "number" || body.max_tokens < 1) {
        return sendError(res, 400, "max_tokens must be a positive integer")
      }

      // Log
      if (manager.shouldLog("request")) {
        const logger = createRequestLogger("POST", "/v1/messages")
        logger.logRequest(body)
        ;(req as any)._logger = logger
      }

      await handler(req, res, body)
    })

    // GET /v1/models (Anthropic format)
    router.get("/v1/models", async ({ req, res }) => {
      await handler(req, res, null)
    })
  }

  parseRequest(body: any): InternalRequest {
    const messages: InternalMessage[] = []

    for (const msg of body.messages || []) {
      if (typeof msg.content === "string") {
        // Simple string content
        messages.push({
          role: msg.role,
          content: msg.content,
        })
        continue
      }

      // Array content (Anthropic format)
      if (Array.isArray(msg.content)) {
        const content: ContentPart[] = []

        for (const block of msg.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text })
          } else if (block.type === "thinking") {
            content.push({ type: "reasoning", text: block.thinking })
          } else if (block.type === "tool_use") {
            content.push({
              type: "tool_use",
              toolCallId: block.id,
              toolName: block.name,
              input: block.input,
            })
          } else if (block.type === "tool_result") {
            // Tool results go as tool role messages
            const toolContent = block.content
              ? (typeof block.content === "string" 
                  ? block.content 
                  : block.content.map((c: any) => c.text || "").join(""))
              : ""
            messages.push({
              role: "tool",
              content: toolContent,
              toolCallId: block.tool_use_id,
            })
            continue
          }
        }

        if (content.length > 0) {
          messages.push({ role: msg.role, content })
        }
      }
    }

    // Convert tools - pass raw schema, core proxy will handle conversion
    const tools: InternalTool[] | undefined = body.tools?.map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema || {},
    }))

    return {
      model: body.model || this.config.defaultModel,
      messages,
      system: body.system,
      tools,
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_tokens,
      stream: body.stream,
      stop: body.stop_sequences,
      // Anthropic doesn't have these, but we can pass through
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      seed: undefined,
    }
  }

  formatResponse(response: InternalResponse, req?: any): any {
    const content: any[] = []

    for (const part of response.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text })
      } else if (part.type === "reasoning") {
        content.push({ type: "thinking", thinking: part.text })
      } else if (part.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        })
      }
    }

    // Map finish reason
    let stopReason = "end_turn"
    if (response.finishReason === "tool_use") {
      stopReason = "tool_use"
    } else if (response.finishReason === "length") {
      stopReason = "max_tokens"
    }

    return {
      id: response.id,
      type: "message",
      role: "assistant",
      content,
      model: response.model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
      },
    }
  }

  formatStreamChunk(chunk: StreamChunk, context: { messageId: string; model: string }): any {
    // Get or create state for this stream
    if (!this.streamState.has(context)) {
      this.streamState.set(context, { blockIndex: 0, currentType: null })
    }
    const state = this.streamState.get(context)!

    if (chunk.type === "text") {
      // Start new text block if needed
      if (state.currentType !== "text") {
        if (state.currentType !== null) {
          // Close previous block
          const stopEvent = { type: "content_block_stop", index: state.blockIndex }
          state.blockIndex++
          state.currentType = "text"
          // Return stop event first, then start new block
          return [
            stopEvent,
            { type: "content_block_start", index: state.blockIndex, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: state.blockIndex, delta: { type: "text_delta", text: chunk.text } },
          ]
        }
        state.currentType = "text"
        return [
          { type: "content_block_start", index: state.blockIndex, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: state.blockIndex, delta: { type: "text_delta", text: chunk.text } },
        ]
      }
      return { type: "content_block_delta", index: state.blockIndex, delta: { type: "text_delta", text: chunk.text } }
    }

    if (chunk.type === "reasoning") {
      // Start new thinking block if needed
      if (state.currentType !== "thinking") {
        if (state.currentType !== null) {
          const stopEvent = { type: "content_block_stop", index: state.blockIndex }
          state.blockIndex++
          state.currentType = "thinking"
          return [
            stopEvent,
            { type: "content_block_start", index: state.blockIndex, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: state.blockIndex, delta: { type: "thinking_delta", thinking: chunk.text } },
          ]
        }
        state.currentType = "thinking"
        return [
          { type: "content_block_start", index: state.blockIndex, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: state.blockIndex, delta: { type: "thinking_delta", thinking: chunk.text } },
        ]
      }
      return { type: "content_block_delta", index: state.blockIndex, delta: { type: "thinking_delta", thinking: chunk.text } }
    }

    if (chunk.type === "tool_use") {
      // Start new tool_use block if needed
      if (state.currentType !== "tool_use") {
        if (state.currentType !== null) {
          const stopEvent = { type: "content_block_stop", index: state.blockIndex }
          state.blockIndex++
          state.currentType = "tool_use"
          return [
            stopEvent,
            { type: "content_block_start", index: state.blockIndex, content_block: { type: "tool_use", id: chunk.toolCallId, name: chunk.toolName } },
            { type: "content_block_delta", index: state.blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(chunk.input || {}) } },
          ]
        }
        state.currentType = "tool_use"
        return [
          { type: "content_block_start", index: state.blockIndex, content_block: { type: "tool_use", id: chunk.toolCallId, name: chunk.toolName } },
          { type: "content_block_delta", index: state.blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(chunk.input || {}) } },
        ]
      }
      return { type: "content_block_delta", index: state.blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(chunk.input || {}) } }
    }

    if (chunk.type === "done") {
      // Close any open block, then send message_delta and message_stop
      const events: any[] = []
      if (state.currentType !== null) {
        events.push({ type: "content_block_stop", index: state.blockIndex })
      }
      events.push({
        type: "message_delta",
        delta: { stop_reason: chunk.finishReason || "end_turn", stop_sequence: null },
        usage: { output_tokens: chunk.usage?.outputTokens || 0 },
      })
      events.push({ type: "message_stop" })
      this.streamState.delete(context)
      return events
    }

    return null
  }

  formatError(error: any): any {
    const message = String(error)
    
    if (message.includes("invalid_request_error") || message.includes("Invalid")) {
      return {
        type: "error",
        error: {
          type: "invalid_request_error",
          message,
        },
      }
    }

    return {
      type: "error",
      error: {
        type: "api_error",
        message,
      },
    }
  }
}
