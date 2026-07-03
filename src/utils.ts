import { IncomingMessage, ServerResponse } from "node:http"

const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * Parse request body as JSON with size limit and error handling
 */
export function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalSize = 0

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error("Invalid JSON in request body"))
      }
    })

    req.on("error", (err) => {
      reject(err)
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
  try {
    res.end(JSON.stringify(data))
  } catch {
    res.end(JSON.stringify({ error: "Failed to serialize response" }))
  }
}


