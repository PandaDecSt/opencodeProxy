import { mkdirSync, appendFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { getLogManager, type LogConfig } from "./log-config.js"

export interface LogEntry {
  timestamp: string
  requestId: string
  method: string
  path: string
  model?: string
  requestBody?: any
  responseStatus?: number
  responseBody?: any
  durationMs?: number
  error?: string
}

const LOG_DIR = resolve(process.cwd(), "logs")

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

function formatJson(obj: any): string {
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface RequestLogger {
  id: string
  startTime: number
  logRequest(body: any): void
  logResponse(status: number, body: any): void
  logError(error: string): void
  end(): void
}

export function createRequestLogger(method: string, path: string): RequestLogger {
  const id = generateRequestId()
  const startTime = Date.now()
  let logged = false
  const manager = getLogManager()

  ensureLogDir()

  const logger: RequestLogger = {
    id,
    startTime,

    logRequest(body: any) {
      if (!manager.shouldLog("request")) return

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        requestId: id,
        method,
        path,
        model: body?.model,
        requestBody: manager.sanitize(body),
      }

      if (manager.shouldLog("request")) {
        console.log(`\n${"=".repeat(60)}`)
        console.log(`[${entry.timestamp}] REQUEST ${id}`)
        console.log(`${"─".repeat(60)}`)
        console.log(`Model: ${entry.model || "N/A"}`)
        
        // System prompt (supports both string and Anthropic array format)
        if (body?.system) {
          const systemText = typeof body.system === "string"
            ? body.system
            : Array.isArray(body.system)
            ? body.system.map((b: any) => b.text || "").join("\n\n")
            : ""
          if (systemText) {
            console.log(`System: ${manager.truncate(systemText, 200)}`)
          }
        }
        
        console.log(`Messages:`)
        if (body?.messages) {
          for (const msg of body.messages) {
            const content = typeof msg.content === "string"
              ? manager.truncate(msg.content)
              : manager.truncate(JSON.stringify(msg.content))
            console.log(`  [${msg.role}] ${content}`)
          }
        }
        if (body?.tools && manager.shouldLog("toolCalls")) {
          console.log(`Tools (${body.tools.length}):`)
          for (const tool of body.tools) {
            // Support both OpenAI format (tool.function) and Anthropic format (tool.name)
            const name = tool.function?.name || tool.name || "unknown"
            const desc = tool.function?.description || tool.description || "(no description)"
            console.log(`  - ${name}: ${desc}`)
            const params = tool.function?.parameters || tool.input_schema
            if (params?.properties) {
              const props = params.properties
              const required = params.required || []
              for (const [key, val] of Object.entries(props) as any) {
                const req = required.includes(key) ? "(required)" : "(optional)"
                console.log(`      ${key} ${req}: ${val.type || "any"} - ${val.description || ""}`)
              }
            }
          }
        }
        
        if (manager.shouldLog("timing")) {
          console.log(`Stream: ${body?.stream || false}`)
        }
      }
    },

    logResponse(status: number, body: any) {
      logged = true
      const duration = Date.now() - startTime
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        requestId: id,
        method,
        path,
        responseStatus: status,
        responseBody: body,
        durationMs: duration,
      }

      if (manager.shouldLog("response")) {
        console.log(`${"─".repeat(60)}`)
        console.log(`[${entry.timestamp}] RESPONSE ${id} (${duration}ms) [${status}]`)
        console.log(`${"─".repeat(60)}`)

        // OpenAI format
        if (body?.choices) {
          for (const choice of body.choices) {
            if (choice.message?.content) {
              console.log(`Content: ${manager.truncate(choice.message.content, 500)}`)
            }
            if (choice.message?.reasoning && manager.shouldLog("reasoning")) {
              const reasoning = choice.message.reasoning
                .map((r: any) => manager.truncateReasoning(r.text || ""))
                .join(" ")
              console.log(`Reasoning: ${reasoning}`)
            }
            if (choice.message?.tool_calls && manager.shouldLog("toolCalls")) {
              console.log(`Tool Calls:`)
              for (const tc of choice.message.tool_calls) {
                console.log(`  - ${tc.function?.name}(${tc.function?.arguments})`)
              }
            }
            if (choice.finish_reason) {
              console.log(`Finish: ${choice.finish_reason}`)
            }
          }
        }

        // Anthropic format
        if (body?.type === "message" && body?.content) {
          for (const block of body.content) {
            if (block.type === "text") {
              console.log(`Content: ${manager.truncate(block.text, 500)}`)
            }
            if (block.type === "thinking" && manager.shouldLog("reasoning")) {
              console.log(`Reasoning: ${manager.truncateReasoning(block.thinking || "")}`)
            }
            if (block.type === "tool_use" && manager.shouldLog("toolCalls")) {
              console.log(`Tool Call: ${block.name}(${JSON.stringify(block.input)})`)
            }
          }
          if (body.stop_reason) {
            console.log(`Stop: ${body.stop_reason}`)
          }
        }

        // Usage (support both formats)
        if (body?.usage && manager.shouldLog("timing")) {
          const prompt = body.usage.prompt_tokens ?? body.usage.input_tokens ?? "?"
          const completion = body.usage.completion_tokens ?? body.usage.output_tokens ?? "?"
          const total = body.usage.total_tokens ?? (prompt !== "?" && completion !== "?" ? Number(prompt) + Number(completion) : "?")
          console.log(`Tokens: prompt=${prompt} completion=${completion} total=${total}`)
        }

        console.log(`${"=".repeat(60)}\n`)
      }

      if (manager.shouldLogToFile("response")) {
        const logPath = resolve(LOG_DIR, manager.getConfig().file.path.replace(/^logs\//, ""))
        appendFileSync(logPath, formatJson(entry) + "\n")
      }
    },

    logError(error: string) {
      logged = true
      const duration = Date.now() - startTime
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        requestId: id,
        method,
        path,
        durationMs: duration,
        error,
      }

      if (manager.shouldLog("error")) {
        console.log(`${"─".repeat(60)}`)
        console.log(`[${entry.timestamp}] ERROR ${id} (${duration}ms)`)
        console.log(`${"─".repeat(60)}`)
        console.log(`Error: ${error}`)
        console.log(`${"=".repeat(60)}\n`)
      }

      if (manager.shouldLogToFile("error")) {
        const logPath = resolve(LOG_DIR, manager.getConfig().file.path.replace(/^logs\//, ""))
        appendFileSync(logPath, formatJson(entry) + "\n")
      }
    },

    end() {
      if (!logged) {
        this.logResponse(200, { _truncated: true })
      }
    },
  }

  return logger
}