import { IncomingMessage, ServerResponse } from "node:http"
import { streamText, generateText } from "ai"
import { jsonSchema } from "ai"
import type { ProxyConfig } from "./types.js"
import { createProviderClient } from "./provider.js"
import { findModelMapping, getDefaultModel } from "./config.js"
import { createRequestLogger, type RequestLogger } from "./logger.js"
import { storeOriginalToolDefs } from "./provider.js"
import { parseBody, sendError } from "./utils.js"

export type { RequestLogger }

const providerClient = createProviderClient()

export async function handleModels(_req: IncomingMessage, res: ServerResponse, config: ProxyConfig) {
  const models = config.modelMappings.map((m) => ({
    id: m.externalId,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: m.providerId,
  }))

  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ object: "list", data: models }))
}

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, config: ProxyConfig) {
  const logger = createRequestLogger(req.method || "POST", req.url || "/v1/chat/completions")
  const body = await parseBody(req)
  if (!body || !body.messages || !Array.isArray(body.messages)) {
    logger.logError("Invalid request: messages array required")
    return sendError(res, 400, "Invalid request: messages array required")
  }

  logger.logRequest(body)

  const modelId = body.model || config.defaultModel
  const mapping = findModelMapping(modelId, config) || getDefaultModel(config)

  const languageModel = providerClient.getLanguageModel(mapping)

  const {
    stream = false,
    messages,
    temperature = 0.7,
    top_p = 1,
    max_tokens,
    tools,
    tool_choice,
    n,
    stop,
    presence_penalty,
    frequency_penalty,
    seed,
    user,
    response_format,
  } = body

  // Separate system messages and convert to instructions
  const systemMessages = messages.filter((m: any) => m.role === "system")
  const instructions = systemMessages.map((m: any) => m.content).join("\n")
  const nonSystemMessages = messages.filter((m: any) => m.role !== "system")

  const sdkMessages = convertMessages(nonSystemMessages)
  
  // Store original tool definitions before conversion
  if (tools && tools.length > 0) {
    storeOriginalToolDefs(tools)
  }
  
  const sdkTools = convertTools(tools)

  const streamOpts = {
    temperature,
    topP: top_p,
    maxOutputTokens: max_tokens ?? config.maxTokens,
    tools: sdkTools,
    system: instructions || undefined,
    stopSequences: stop ? (Array.isArray(stop) ? stop : [stop]) : undefined,
    presencePenalty: presence_penalty,
    frequencyPenalty: frequency_penalty,
    seed,
  }

  if (stream) {
    return handleStreamingChat(res, languageModel, sdkMessages, { ...streamOpts, model: modelId }, logger)
  }

  return handleNonStreamingChat(res, languageModel, sdkMessages, { ...streamOpts, model: modelId }, logger, body)
}

function convertMessages(messages: any[]): any[] {
  // Build a map from tool_call_id to tool name from assistant messages
  const toolCallIdToName = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIdToName.set(tc.id, tc.function.name)
      }
    }
  }

  return messages.map((msg: any) => {
    if (msg.role === "tool") {
      const toolName = toolCallIdToName.get(msg.tool_call_id) || "unknown"
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id,
          toolName: toolName,
          output: { type: "text", value: msg.content },
        }],
      }
    }
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      // Convert tool_calls to content array with tool-call parts
      const content: any[] = []
      // Add reasoning part if present
      if (msg.reasoning && Array.isArray(msg.reasoning)) {
        for (const r of msg.reasoning) {
          content.push({ type: "reasoning", text: r.text || "" })
        }
      }
      // Always add text part (even if empty) to satisfy schema
      content.push({ type: "text", text: msg.content || "" })
      for (const tc of msg.tool_calls) {
        let input = {}
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {}
        content.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: input,
        })
      }
      return {
        role: "assistant",
        content: content,
      }
    }
    // Handle assistant messages with reasoning but no tool calls
    if (msg.role === "assistant" && msg.reasoning && Array.isArray(msg.reasoning) && msg.reasoning.length > 0) {
      const content: any[] = []
      for (const r of msg.reasoning) {
        content.push({ type: "reasoning", text: r.text || "" })
      }
      content.push({ type: "text", text: msg.content || "" })
      return {
        role: "assistant",
        content: content,
      }
    }
    return { role: msg.role, content: msg.content }
  })
}

function convertTools(tools?: any[]): any {
  if (!tools) return undefined
  const result: Record<string, any> = {}
  for (const tool of tools) {
    const params = tool.function.parameters || {}
    console.log(`[Tool] ${tool.function.name}:`, JSON.stringify(params, null, 2))
    result[tool.function.name] = {
      description: tool.function.description,
      inputSchema: jsonSchema(params),
    }
  }
  return result
}

async function handleStreamingChat(
  res: ServerResponse,
  languageModel: any,
  messages: any[],
  options: any,
  logger: RequestLogger
) {
  const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const created = Math.floor(Date.now() / 1000)

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })

  try {
    const result = streamText({
      model: languageModel,
      messages,
      system: options.system,
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      tools: options.tools,
      stopSequences: options.stopSequences,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      seed: options.seed,
    })

    let toolCallsSent = false

    for await (const chunk of result.textStream) {
      const data = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: options.model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      }
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const toolCalls = await result.toolCalls
    if (toolCalls && toolCalls.length > 0) {
      toolCallsSent = true
      const data = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: options.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: toolCalls.map((tc: any, i: number) => ({
                index: i,
                id: tc.toolCallId,
                type: "function",
                function: {
                  name: tc.toolName,
                  arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
                },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
      }
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const finalData = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: options.model,
      choices: [{ index: 0, delta: {}, finish_reason: toolCallsSent ? "tool_calls" : "stop" }],
    }
    res.write(`data: ${JSON.stringify(finalData)}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
    logger.logResponse(200, { choices: [{ message: { content: "(streamed)" } }], usage: null })
  } catch (error) {
    console.error("Streaming error:", error)
    logger.logError(String(error))
    const errorData = { error: { message: String(error), type: "internal_error", code: 500 } }
    res.write(`data: ${JSON.stringify(errorData)}\n\n`)
    res.end()
  }
}

async function handleNonStreamingChat(
  res: ServerResponse,
  languageModel: any,
  messages: any[],
  options: any,
  logger: RequestLogger,
  rawBody: any
) {
  try {
    const result = await generateText({
      model: languageModel,
      messages,
      system: options.system,
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      tools: options.tools,
      stopSequences: options.stopSequences,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      seed: options.seed,
    })

    const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const created = Math.floor(Date.now() / 1000)

    const response = {
      id: completionId,
      object: "chat.completion",
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.text || "",
            reasoning: result.reasoning || undefined,
            tool_calls: result.toolCalls?.map((tc: any) => ({
              id: tc.toolCallId,
              type: "function",
              function: {
                name: tc.toolName,
                arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
              },
            })),
          },
          finish_reason: result.finishReason === "tool-calls" ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: result.usage?.inputTokens ?? 0,
        completion_tokens: result.usage?.outputTokens ?? 0,
        total_tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      },
    }

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(response))
    logger.logResponse(200, response)
  } catch (error: any) {
    console.error("Generation error:", error)
    logger.logError(String(error))
    sendError(res, 500, String(error))
  }
}