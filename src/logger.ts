import { mkdirSync, appendFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

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
const LOG_FILE = resolve(LOG_DIR, "proxy.log")

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

  ensureLogDir()

  const logger: RequestLogger = {
    id,
    startTime,

    logRequest(body: any) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        requestId: id,
        method,
        path,
        model: body?.model,
        requestBody: sanitizeBody(body),
      }
      console.log(`\n${"=".repeat(60)}`)
      console.log(`[${entry.timestamp}] REQUEST ${id}`)
      console.log(`${"─".repeat(60)}`)
      console.log(`Model: ${entry.model || "N/A"}`)
      console.log(`Messages:`)
      if (body?.messages) {
        for (const msg of body.messages) {
          const content = typeof msg.content === "string"
            ? msg.content.slice(0, 200)
            : JSON.stringify(msg.content).slice(0, 200)
          console.log(`  [${msg.role}] ${content}${(msg.content?.length || 0) > 200 ? "..." : ""}`)
        }
      }
      if (body?.tools) {
        console.log(`Tools (${body.tools.length}):`)
        for (const tool of body.tools) {
          const fn = tool.function
          console.log(`  - ${fn?.name}: ${fn?.description || "(no description)"}`)
          if (fn?.parameters?.properties) {
            const props = fn.parameters.properties
            const required = fn.parameters.required || []
            for (const [key, val] of Object.entries(props) as any) {
              const req = required.includes(key) ? "(required)" : "(optional)"
              console.log(`      ${key} ${req}: ${val.type || "any"} - ${val.description || ""}`)
            }
          }
        }
      }
      console.log(`Stream: ${body?.stream || false}`)
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

      console.log(`${"─".repeat(60)}`)
      console.log(`[${entry.timestamp}] RESPONSE ${id} (${duration}ms) [${status}]`)
      console.log(`${"─".repeat(60)}`)

      if (body?.choices) {
        for (const choice of body.choices) {
          if (choice.message?.content) {
            console.log(`Content: ${choice.message.content.slice(0, 500)}`)
          }
          if (choice.message?.reasoning) {
            const reasoning = choice.message.reasoning
              .map((r: any) => r.text?.slice(0, 200))
              .join(" ")
            console.log(`Reasoning: ${reasoning.slice(0, 300)}...`)
          }
          if (choice.message?.tool_calls) {
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

      if (body?.usage) {
        console.log(`Tokens: prompt=${body.usage.prompt_tokens} completion=${body.usage.completion_tokens} total=${body.usage.total_tokens}`)
      }

      console.log(`${"=".repeat(60)}\n`)

      appendFileSync(LOG_FILE, formatJson(entry) + "\n")
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

      console.log(`${"─".repeat(60)}`)
      console.log(`[${entry.timestamp}] ERROR ${id} (${duration}ms)`)
      console.log(`${"─".repeat(60)}`)
      console.log(`Error: ${error}`)
      console.log(`${"=".repeat(60)}\n`)

      appendFileSync(LOG_FILE, formatJson(entry) + "\n")
    },

    end() {
      if (!logged) {
        this.logResponse(200, { _truncated: true })
      }
    },
  }

  return logger
}

function sanitizeBody(body: any): any {
  if (!body) return body
  const sanitized = { ...body }
  // Truncate long messages for logging
  if (sanitized.messages) {
    sanitized.messages = sanitized.messages.map((msg: any) => ({
      ...msg,
      content: typeof msg.content === "string"
        ? msg.content.length > 500
          ? msg.content.slice(0, 500) + "...[truncated]"
          : msg.content
        : msg.content,
    }))
  }
  return sanitized
}