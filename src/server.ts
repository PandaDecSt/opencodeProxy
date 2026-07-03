import { createServer } from "node:http"
import { loadConfig } from "./config.js"
import { handleChatCompletions, handleModels } from "./handlers.js"
import { getLogManager } from "./log-config.js"
import { Router } from "./router.js"
import { parseBody, sendJson, sendError } from "./utils.js"

async function main() {
  const config = await loadConfig()
  const logManager = getLogManager()

  const router = new Router()

  // CORS middleware for admin endpoints
  router.all("/admin/*", async ({ req, res }) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
    }
  })

  // OpenAI compatible endpoints
  router.post("/v1/chat/completions", async ({ req, res }) => {
    await handleChatCompletions(req, res, config)
  })

  router.get("/v1/models", async ({ req, res }) => {
    await handleModels(req, res, config)
  })

  // Health check
  router.get("/health", async ({ res }) => {
    sendJson(res, 200, { status: "ok", provider: "opencode-proxy" })
  })

  // Admin: Log config endpoints
  router.get("/admin/logs", async ({ res }) => {
    sendJson(res, 200, logManager.getConfig())
  })

  router.put("/admin/logs", async ({ req, res }) => {
    const body = await parseBody(req)
    const updated = logManager.updateConfig(body)
    sendJson(res, 200, { success: true, config: updated })
  })

  router.post("/admin/logs/toggle", async ({ req, res }) => {
    const body = await parseBody(req)
    const current = logManager.getConfig()
    logManager.updateConfig({ enabled: body.enabled ?? !current.enabled })
    sendJson(res, 200, { success: true, enabled: logManager.getConfig().enabled })
  })

  router.post("/admin/logs/console/:key", async ({ req, res, params }) => {
    const body = await parseBody(req)
    if (typeof body.enabled !== "boolean") {
      return sendError(res, 400, "Body must have 'enabled' boolean field")
    }
    logManager.updateConsoleSwitch(params.key as any, body.enabled)
    sendJson(res, 200, { success: true, key: params.key, enabled: body.enabled })
  })

  router.post("/admin/logs/file/:key", async ({ req, res, params }) => {
    const body = await parseBody(req)
    if (typeof body.enabled !== "boolean") {
      return sendError(res, 400, "Body must have 'enabled' boolean field")
    }
    logManager.updateFileSwitch(params.key as any, body.enabled)
    sendJson(res, 200, { success: true, key: params.key, enabled: body.enabled })
  })

  // Create server
  const server = createServer(async (req, res) => {
    try {
      const handled = await router.handle(req, res)
      if (!handled) {
        sendError(res, 404, "Not found")
      }
    } catch (error) {
      console.error("Request error:", error)
      sendError(res, 500, String(error))
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
