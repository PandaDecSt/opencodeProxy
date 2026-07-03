import { IncomingMessage, ServerResponse } from "node:http"

export interface ParsedRequest extends IncomingMessage {
  body?: any
}

export function createReqMiddleware(req: IncomingMessage, res: ServerResponse) {
  const parsedReq = req as ParsedRequest
  
  return {
    async parseBody(): Promise<any> {
      if (parsedReq.body !== undefined) return parsedReq.body

      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) return {}

      try {
        parsedReq.body = JSON.parse(raw)
        return parsedReq.body
      } catch {
        parsedReq.body = {}
        return {}
      }
    },

    sendJSON(status: number, data: any) {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(data))
    },

    sendSSE(data: string) {
      res.write(`data: ${data}\n\n`)
    },

    endSSE() {
      res.write("data: [DONE]\n\n")
      res.end()
    },

    setSSEHeaders() {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
    },
  }
}