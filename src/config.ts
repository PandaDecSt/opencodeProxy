import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ModelMapping, ProxyConfig } from "./types.js"

const DEFAULT_CONFIG: ProxyConfig = {
  port: 8080,
  host: "127.0.0.1",
  modelMappings: [
    { externalId: "free-claude", providerId: "anthropic", modelId: "claude-3-5-haiku-20241022", displayName: "Claude 3.5 Haiku (Free)" },
    { externalId: "free-gpt4o-mini", providerId: "openai", modelId: "gpt-4o-mini", displayName: "GPT-4o Mini (Free tier)" },
    { externalId: "free-gemini-flash", providerId: "google", modelId: "gemini-1.5-flash", displayName: "Gemini 1.5 Flash (Free)" },
    { externalId: "free-deepseek", providerId: "deepseek", modelId: "deepseek-chat", displayName: "DeepSeek Chat (Free)" },
  ],
  defaultModel: "free-claude",
  requestTimeout: 120000,
  maxTokens: 4096,
}

export async function loadConfig(): Promise<ProxyConfig> {
  const configPaths = [
    resolve(process.cwd(), "opencode-proxy.json"),
    resolve(process.cwd(), ".opencode-proxy.json"),
    resolve(process.env.HOME || "", ".config", "opencode-proxy.json"),
  ]

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf8")
        const userConfig = JSON.parse(content)
        console.log(`[opencode-proxy] Loaded config from ${path}`)
        return { ...DEFAULT_CONFIG, ...userConfig, modelMappings: userConfig.modelMappings ?? DEFAULT_CONFIG.modelMappings }
      } catch (e) {
        console.warn(`[opencode-proxy] Failed to parse config at ${path}:`, e)
      }
    }
  }

  console.log("[opencode-proxy] Using default config (no config file found)")
  return DEFAULT_CONFIG
}

export function findModelMapping(externalId: string, config: ProxyConfig): ModelMapping | undefined {
  return config.modelMappings.find((m) => m.externalId === externalId)
}

export function getDefaultModel(config: ProxyConfig): ModelMapping {
  const mapping = config.modelMappings.find((m) => m.externalId === config.defaultModel)
  return mapping ?? config.modelMappings[0]
}