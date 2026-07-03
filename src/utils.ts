import { IncomingMessage, ServerResponse } from "node:http"

/**
 * Parse request body as JSON
 */
export function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/**
 * Standard error response format
 */
export interface ErrorResponse {
  error: {
    message: string
    type: string
    code: number
    details?: any
  }
}

export function sendError(res: ServerResponse, status: number, message: string, details?: any): void {
  if (res.writableEnded) return

  const response: ErrorResponse = {
    error: {
      message,
      type: getErrorType(status),
      code: status,
      ...(details && { details }),
    },
  }

  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(response))
}

function getErrorType(status: number): string {
  if (status === 400) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 500) return "server_error"
  return "api_error"
}

/**
 * Send success JSON response
 */
export function sendJson(res: ServerResponse, status: number, data: any): void {
  if (res.writableEnded) return
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

/**
 * Extract path parameters from URL pattern
 */
export function extractParams(pattern: string, pathname: string): Record<string, string> | null {
  const paramNames: string[] = []
  const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name)
    return "([^/]+)"
  })
  const regex = new RegExp(`^${regexStr}$`)
  const match = pathname.match(regex)
  if (!match) return null

  const params: Record<string, string> = {}
  paramNames.forEach((name, i) => {
    params[name] = decodeURIComponent(match[i + 1])
  })
  return params
}
