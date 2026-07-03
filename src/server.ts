import { createServer } from "node:http"
import { loadConfig } from "./config.js"
import { handleChatCompletions, handleModels } from "./handlers.js"
import { getLogManager } from "./log-config.js"

function parseBody(req: any): Promise<any> {
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

async function main() {
  const config = await loadConfig()
  const logManager = getLogManager()

  const server = createServer(async (req, res) => {
    try {
      // CORS headers for admin endpoints
      if (req.url?.startsWith("/admin/")) {
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type")
        if (req.method === "OPTIONS") {
          res.writeHead(204)
          res.end()
          return
        }
      }

      if (req.url?.startsWith("/v1/chat/completions") && req.method === "POST") {
        await handleChatCompletions(req, res, config)
      } else if (req.url?.startsWith("/v1/models") && req.method === "GET") {
        await handleModels(req, res, config)
      } else if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "ok", provider: "opencode-proxy" }))
      }
      // Admin: Get log config
      else if (req.url === "/admin/logs" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(logManager.getConfig(), null, 2))
      }
      // Admin: Update log config (partial update)
      else if (req.url === "/admin/logs" && req.method === "PUT") {
        const body = await parseBody(req)
        const updated = logManager.updateConfig(body)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true, config: updated }))
      }
      // Admin: Toggle a specific console switch
      else if (req.url?.startsWith("/admin/logs/console/") && req.method === "POST") {
        const key = req.url.split("/admin/logs/console/")[1]
        const body = await parseBody(req)
        if (key && typeof body.enabled === "boolean") {
          logManager.updateConsoleSwitch(key as any, body.enabled)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: true, key, enabled: body.enabled }))
        } else {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Invalid request. Body: { enabled: boolean }" }))
        }
      }
      // Admin: Toggle a specific file switch
      else if (req.url?.startsWith("/admin/logs/file/") && req.method === "POST") {
        const key = req.url.split("/admin/logs/file/")[1]
        const body = await parseBody(req)
        if (key && typeof body.enabled === "boolean") {
          logManager.updateFileSwitch(key as any, body.enabled)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: true, key, enabled: body.enabled }))
        } else {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Invalid request. Body: { enabled: boolean }" }))
        }
      }
      // Admin: Quick toggle all console logging
      else if (req.url === "/admin/logs/toggle" && req.method === "POST") {
        const body = await parseBody(req)
        const current = logManager.getConfig()
        logManager.updateConfig({ enabled: body.enabled ?? !current.enabled })
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true, enabled: logManager.getConfig().enabled }))
      }
      else {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "Not found", type: "not_found", code: 404 } }))
      }
    } catch (error) {
      console.error("Request error:", error)
      if (!res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: String(error), type: "internal_error", code: 500 } }))
      }
    }
  })

  const port = config.port ?? 8080
  const host = config.host ?? "127.0.0.1"
  
  server.listen(port, host, () => {
    console.log(`[opencode-proxy] Server running at http://${host}:${port}`)
    console.log(`[opencode-proxy] OpenAI compatible endpoints:`)
    console.log(`  POST   /v1/chat/completions`)
    console.log(`  GET    /v1/models`)
    console.log(`  GET    /health`)
    console.log(`[opencode-proxy] Admin endpoints:`)
    console.log(`  GET    /admin/logs          - Get log config`)
    console.log(`  PUT    /admin/logs          - Update log config`)
    console.log(`  POST   /admin/logs/toggle   - Toggle all logging`)
    console.log(`  POST   /admin/logs/console/:key - Toggle console switch`)
    console.log(`  POST   /admin/logs/file/:key    - Toggle file switch`)
    console.log(`[opencode-proxy] Available models:`)
    config.modelMappings.forEach(m => console.log(`  - ${m.externalId} (${m.providerId}/${m.modelId})`))
  })

  process.on("SIGINT", () => {
    console.log("\n[opencode-proxy] Shutting down...")
    server.close(() => process.exit(0))
  })
}

main().catch(console.error)