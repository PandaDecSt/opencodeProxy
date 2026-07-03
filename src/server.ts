import { createServer } from "node:http"
import { loadConfig } from "./config.js"
import { getLogManager } from "./log-config.js"
import { Router } from "./router.js"
import { parseBody, sendJson, sendError } from "./utils.js"
import { FormatRegistry } from "./formats/index.js"
import type { ProxyConfig } from "./types.js"

function checkAdminAuth(req: any, res: any, config: ProxyConfig): boolean {
  // Skip auth if no admin key configured
  if (!config.adminApiKey) return true

  const authHeader = req.headers.authorization
  if (!authHeader) {
    sendError(res, 401, "Authorization header required")
    return false
  }

  // Support both "Bearer <key>" and "Basic <key>" formats
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader.startsWith("Basic ")
    ? Buffer.from(authHeader.slice(6), "base64").toString()
    : authHeader

  if (token !== config.adminApiKey) {
    sendError(res, 403, "Invalid admin API key")
    return false
  }

  return true
}

async function main() {
  const config = await loadConfig()
  const logManager = getLogManager()

  const router = new Router()
  const formatRegistry = new FormatRegistry(config)

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

  // Register format routes
  formatRegistry.registerAllRoutes(router)

  // Health check
  router.get("/health", async ({ res }) => {
    sendJson(res, 200, {
      status: "ok",
      provider: "opencode-proxy",
      formats: formatRegistry.getAll().map(a => a.name),
    })
  })

  // Admin: Log config endpoints
  router.get("/admin/logs", async ({ req, res }) => {
    if (!checkAdminAuth(req, res, config)) return
    sendJson(res, 200, logManager.getConfig())
  })

  router.put("/admin/logs", async ({ req, res }) => {
    if (!checkAdminAuth(req, res, config)) return
    const body = await parseBody(req)
    const updated = logManager.updateConfig(body)
    sendJson(res, 200, { success: true, config: updated })
  })

  router.post("/admin/logs/toggle", async ({ req, res }) => {
    if (!checkAdminAuth(req, res, config)) return
    const body = await parseBody(req)
    const current = logManager.getConfig()
    logManager.updateConfig({ enabled: body.enabled ?? !current.enabled })
    sendJson(res, 200, { success: true, enabled: logManager.getConfig().enabled })
  })

  router.post("/admin/logs/console/:key", async ({ req, res, params }) => {
    if (!checkAdminAuth(req, res, config)) return
    const body = await parseBody(req)
    if (typeof body.enabled !== "boolean") {
      return sendError(res, 400, "Body must have 'enabled' boolean field")
    }
    const validKeys = ["request", "response", "error", "debug", "info", "warn"]
    if (!validKeys.includes(params.key)) {
      return sendError(res, 400, `Invalid key. Must be one of: ${validKeys.join(", ")}`)
    }
    logManager.updateConsoleSwitch(params.key as any, body.enabled)
    sendJson(res, 200, { success: true, key: params.key, enabled: body.enabled })
  })

  router.post("/admin/logs/file/:key", async ({ req, res, params }) => {
    if (!checkAdminAuth(req, res, config)) return
    const body = await parseBody(req)
    if (typeof body.enabled !== "boolean") {
      return sendError(res, 400, "Body must have 'enabled' boolean field")
    }
    const validKeys = ["request", "response", "error", "debug", "info", "warn"]
    if (!validKeys.includes(params.key)) {
      return sendError(res, 400, `Invalid key. Must be one of: ${validKeys.join(", ")}`)
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
    console.log(`[opencode-proxy] Supported formats:`)
    formatRegistry.getAll().forEach(a => console.log(`  - ${a.name}`))
    console.log(`[opencode-proxy] OpenAI compatible endpoints:`)
    console.log(`  POST   /v1/chat/completions`)
    console.log(`  GET    /v1/models`)
    console.log(`[opencode-proxy] Anthropic compatible endpoints:`)
    console.log(`  POST   /v1/messages`)
    console.log(`  GET    /v1/models`)
    console.log(`[opencode-proxy] Admin endpoints:`)
    console.log(`  GET    /admin/logs          - Get log config`)
    console.log(`  PUT    /admin/logs          - Update log config`)
    console.log(`  POST   /admin/logs/toggle   - Toggle all logging`)
    console.log(`  POST   /admin/logs/console/:key - Toggle console switch`)
    console.log(`  POST   /admin/logs/file/:key    - Toggle file switch`)
    console.log(`  GET    /health              - Health check`)
    console.log(`[opencode-proxy] Available models:`)
    config.modelMappings.forEach(m => console.log(`  - ${m.externalId} (${m.providerId}/${m.modelId})`))
  })

  process.on("SIGINT", () => {
    console.log("\n[opencode-proxy] Shutting down...")
    server.close(() => process.exit(0))
  })
}

main().catch(console.error)
