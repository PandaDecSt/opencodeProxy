import type { FormatAdapter, InternalRequest, InternalResponse, StreamChunk } from "../core/types.js"
import type { Router, RouteContext } from "../router.js"
import type { ProxyConfig } from "../types.js"
import { sendJson, sendError } from "../utils.js"
import { createRequestLogger } from "../logger.js"
import { getLogManager } from "../log-config.js"
import { OpenAIAdapter } from "./openai.js"
import { AnthropicAdapter } from "./anthropic.js"
import { CoreProxy } from "../core/proxy.js"

export class FormatRegistry {
  private adapters = new Map<string, FormatAdapter>()
  private proxy: CoreProxy
  private config: ProxyConfig

  constructor(config: ProxyConfig) {
    this.config = config
    this.proxy = new CoreProxy(config)
    
    // Register built-in adapters
    this.register(new OpenAIAdapter(config))
    this.register(new AnthropicAdapter(config))
  }

  register(adapter: FormatAdapter) {
    this.adapters.set(adapter.name, adapter)
  }

  get(name: string): FormatAdapter | undefined {
    return this.adapters.get(name)
  }

  getAll(): FormatAdapter[] {
    return Array.from(this.adapters.values())
  }

  registerAllRoutes(router: Router) {
    const manager = getLogManager()

    for (const adapter of this.adapters.values()) {
      adapter.registerRoutes(router, async (req, res, body) => {
        const logger = (req as any)._logger

        try {
          // Handle null body (e.g., GET /v1/models)
          if (!body) {
            const models = this.config?.modelMappings || []
            sendJson(res, 200, {
              object: "list",
              data: models.map(m => ({
                id: m.externalId,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: m.providerId,
              })),
            })
            return
          }

          // Parse request to internal format
          const internalRequest = adapter.parseRequest(body)

          // Handle streaming
          if (internalRequest.stream) {
            return await this.handleStream(adapter, internalRequest, req, res, logger)
          }

          // Non-streaming
          const internalResponse = await this.proxy.handleRequest(internalRequest)

          // Format response
          const response = adapter.formatResponse(internalResponse, req)

          // Log response
          if (logger) {
            logger.logResponse(200, response)
          }

          sendJson(res, 200, response)
        } catch (error: any) {
          console.error(`[${adapter.name}] Error:`, error)

          if (logger) {
            logger.logError(String(error))
          }

          const errorResponse = adapter.formatError?.(error) || {
            error: { message: String(error), type: "api_error", code: 500 }
          }
          sendJson(res, 500, errorResponse)
        }
      })
    }
  }

  private async handleStream(
    adapter: FormatAdapter,
    request: InternalRequest,
    req: any,
    res: any,
    logger: any
  ) {
    const context = {
      completionId: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      messageId: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
      created: Math.floor(Date.now() / 1000),
      model: request.model,
    }

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    try {
      // Send initial event for Anthropic
      if (adapter.name === "anthropic") {
        res.write(`data: ${JSON.stringify({
          type: "message_start",
          message: {
            id: context.messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: request.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`)
      }

      // Stream chunks
      for await (const chunk of this.proxy.handleRequestStream(request)) {
        const formatted = adapter.formatStreamChunk?.(chunk, context)
        if (formatted) {
          // Handle array of events (for multi-event chunks)
          const events = Array.isArray(formatted) ? formatted : [formatted]
          for (const event of events) {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          }
        }
      }

      // Send done
      if (adapter.name === "openai") {
        res.write("data: [DONE]\n\n")
      }

      res.end()

      if (logger) {
        logger.logResponse(200, { choices: [{ message: { content: "(streamed)" } }] })
      }
    } catch (error: any) {
      console.error(`[${adapter.name}] Stream error:`, error)

      const errorResponse = adapter.formatError?.(error) || {
        error: { message: String(error), type: "api_error", code: 500 }
      }
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`)
      res.end()

      if (logger) {
        logger.logError(String(error))
      }
    }
  }
}
