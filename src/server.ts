import { createServer } from "node:http"
import { loadConfig } from "./config.js"
import { handleChatCompletions, handleModels } from "./handlers.js"

async function main() {
  const config = await loadConfig()

  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/v1/chat/completions") && req.method === "POST") {
        await handleChatCompletions(req, res, config)
      } else if (req.url?.startsWith("/v1/models") && req.method === "GET") {
        await handleModels(req, res, config)
      } else if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "ok", provider: "opencode-proxy" }))
      } else {
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
    console.log(`[opencode-proxy] Available models:`)
    config.modelMappings.forEach(m => console.log(`  - ${m.externalId} (${m.providerId}/${m.modelId})`))
  })

  process.on("SIGINT", () => {
    console.log("\n[opencode-proxy] Shutting down...")
    server.close(() => process.exit(0))
  })
}

main().catch(console.error)