import { streamText, generateText } from "ai"
import { jsonSchema } from "ai"
import { createProviderClient, type ProviderClient } from "../provider.js"
import { findModelMapping, getDefaultModel } from "../config.js"
import type { ProxyConfig } from "../types.js"
import { storeOriginalToolDefs, clearOriginalToolDefs } from "../provider.js"
import type {
  InternalRequest,
  InternalResponse,
  InternalMessage,
  InternalTool,
  ContentPart,
  StreamChunk,
  Usage,
} from "./types.js"

export class CoreProxy {
  private providerClient: ProviderClient
  private config: ProxyConfig

  constructor(config: ProxyConfig) {
    this.config = config
    this.providerClient = createProviderClient()
  }

  async handleRequest(request: InternalRequest): Promise<InternalResponse> {
    const mapping = findModelMapping(request.model, this.config) || getDefaultModel(this.config)
    const languageModel = this.providerClient.getLanguageModel(mapping)

    const sdkMessages = this.convertMessages(request.messages)
    const sdkTools = this.convertTools(request.tools)
    const systemPrompt = this.normalizeSystem(request.system)

    // Store original tool definitions for fetch interceptor (in OpenAI format)
    if (request.tools && request.tools.length > 0) {
      storeOriginalToolDefs(request.tools.map(t => {
        // Handle both raw JSON schema and already wrapped format
        let params = t.inputSchema
        if (params?.type === "object" && params?.properties) {
          // Raw JSON schema - wrap in OpenAI format
          return {
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: params,
            }
          }
        }
        // Already in OpenAI format or other format
        return params?.function ? params : {
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: params || {},
          }
        }
      }))
    }

    try {
      const result = await generateText({
        model: languageModel,
        messages: sdkMessages,
        system: systemPrompt,
        temperature: request.temperature,
        topP: request.topP,
        maxOutputTokens: request.maxTokens,
        tools: sdkTools,
        stopSequences: request.stop,
        presencePenalty: request.presencePenalty,
        frequencyPenalty: request.frequencyPenalty,
        seed: request.seed,
      })

      return this.convertResponse(result, request.model)
    } finally {
      clearOriginalToolDefs()
    }
  }

  async *handleRequestStream(request: InternalRequest): AsyncGenerator<StreamChunk> {
    const mapping = findModelMapping(request.model, this.config) || getDefaultModel(this.config)
    const languageModel = this.providerClient.getLanguageModel(mapping)

    const sdkMessages = this.convertMessages(request.messages)
    const sdkTools = this.convertTools(request.tools)
    const systemPrompt = this.normalizeSystem(request.system)

    // Store tool defs BEFORE streamText to avoid race condition
    if (request.tools && request.tools.length > 0) {
      storeOriginalToolDefs(request.tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        }
      })))
    }

    try {
      const result = streamText({
        model: languageModel,
        messages: sdkMessages,
        system: systemPrompt,
        temperature: request.temperature,
        topP: request.topP,
        maxOutputTokens: request.maxTokens,
        tools: sdkTools,
        stopSequences: request.stop,
        presencePenalty: request.presencePenalty,
        frequencyPenalty: request.frequencyPenalty,
        seed: request.seed,
      })

      // Stream text chunks
      for await (const chunk of result.textStream) {
        yield { type: "text", text: chunk }
      }

      // Get tool calls
      const toolCalls = await result.toolCalls
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          yield {
            type: "tool_use",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          }
        }
      }

      // Done
      const finalResult = await result.finishReason
      const finalUsage = await result.usage
      yield {
        type: "done",
        finishReason: this.mapFinishReason(finalResult),
        usage: {
          inputTokens: finalUsage?.inputTokens ?? 0,
          outputTokens: finalUsage?.outputTokens ?? 0,
          totalTokens: (finalUsage?.inputTokens ?? 0) + (finalUsage?.outputTokens ?? 0),
        },
      }
    } finally {
      clearOriginalToolDefs()
    }
  }

  private normalizeSystem(system: string | Array<{ type: string; text: string }> | undefined): string | undefined {
    if (!system) return undefined
    if (typeof system === "string") return system
    // Anthropic format: array of content blocks
    if (Array.isArray(system)) {
      return system
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n\n")
    }
    return undefined
  }

  private convertMessages(messages: InternalMessage[]): any[] {
    // Build tool call id to name map
    const toolCallIdToName = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "tool_use") {
            toolCallIdToName.set(part.toolCallId, part.toolName)
          }
        }
      }
    }

    return messages.map(msg => {
      if (msg.role === "tool") {
        const toolName = toolCallIdToName.get(msg.toolCallId || "") || "unknown"
        return {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: msg.toolCallId,
            toolName,
            output: { type: "text", value: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) },
          }],
        }
      }

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const content: any[] = []
        for (const part of msg.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text })
          } else if (part.type === "reasoning") {
            content.push({ type: "reasoning", text: part.text })
          } else if (part.type === "tool_use") {
            content.push({
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            })
          }
        }
        return { role: "assistant", content }
      }

      return { role: msg.role, content: msg.content }
    })
  }

  private convertTools(tools?: InternalTool[]): any {
    if (!tools) return undefined
    const result: Record<string, any> = {}
    for (const tool of tools) {
      // Handle both raw JSON schema and OpenAI format
      let params = tool.inputSchema
      if (params?.function?.parameters) {
        // Already in OpenAI format
        params = params.function.parameters
      }
      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(params),
      }
    }
    return result
  }

  private mapFinishReason(reason: string | undefined): string {
    switch (reason) {
      case "tool-calls":
        return "tool_use"
      case "stop":
      case "end_turn":
        return "end_turn"
      case "length":
        return "length"
      case "content-filter":
        return "content_filter"
      default:
        return "end_turn"
    }
  }

  private convertResponse(result: any, model: string): InternalResponse {
    const content: ContentPart[] = []

    // Add reasoning
    if (result.reasoning && Array.isArray(result.reasoning)) {
      for (const r of result.reasoning) {
        content.push({ type: "reasoning", text: r.text || "" })
      }
    }

    // Add text
    if (result.text) {
      content.push({ type: "text", text: result.text })
    }

    // Add tool calls to content
    if (result.toolCalls && Array.isArray(result.toolCalls)) {
      for (const tc of result.toolCalls) {
        content.push({
          type: "tool_use",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })
      }
    }

    return {
      id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      model,
      content,
      finishReason: this.mapFinishReason(result.finishReason),
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      },
    }
  }
}
