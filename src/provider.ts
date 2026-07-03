import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

export interface ProviderClient {
  getLanguageModel(mapping: { providerId: string; modelId: string }): any
}

const providerCache = new Map<string, any>()

interface ProviderApiKeyConfig {
  apiKey?: string
}

interface ProxyConfigFile {
  providers?: Record<string, ProviderApiKeyConfig>
}

// Store original tool definitions
const originalToolDefs = new Map<string, any>()

export function storeOriginalToolDefs(tools: any[]) {
  for (const tool of tools) {
    if (tool.function?.name) {
      originalToolDefs.set(tool.function.name, tool)
    }
  }
}

// Intercept fetch to fix tool definitions before sending
const originalFetch = globalThis.fetch
globalThis.fetch = async function(...args: any[]) {
  const [url, options] = args
  if (typeof url === 'string' && url.includes('/chat/completions') && options?.body) {
    try {
      const body = JSON.parse(options.body as string)
      if (body.tools && Array.isArray(body.tools)) {
        // Restore original tool definitions
        body.tools = body.tools.map((tool: any) => {
          const original = originalToolDefs.get(tool.function?.name)
          if (original) {
            return original
          }
          return tool
        })
        options.body = JSON.stringify(body)
      }
    } catch {}
  }
  return originalFetch.apply(this, args as any)
}

export function createProviderClient(): ProviderClient {
  const apiKeyConfig = loadApiKeyConfig()
  
  return {
    getLanguageModel(mapping: { providerId: string; modelId: string }) {
      const cacheKey = `${mapping.providerId}/${mapping.modelId}`
      
      if (providerCache.has(cacheKey)) {
        return providerCache.get(cacheKey)!
      }

      const providerConfig = getProviderConfig(mapping.providerId, apiKeyConfig)
      
      const model = createOpenAICompatible({
        name: providerConfig.name,
        baseURL: providerConfig.baseURL,
        apiKey: providerConfig.apiKey,
        headers: providerConfig.headers,
      })(mapping.modelId)

      providerCache.set(cacheKey, model)
      return model
    },
  }
}

function loadApiKeyConfig(): ProxyConfigFile {
  const configPaths = [
    resolve(process.cwd(), "opencode-proxy.json"),
    resolve(process.cwd(), ".opencode-proxy.json"),
  ]

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf8")
        return JSON.parse(content)
      } catch (e) {
        console.warn(`Failed to parse config at ${path}:`, e)
      }
    }
  }
  return {}
}

function getProviderConfig(providerId: string, apiKeyConfig: ProxyConfigFile) {
  const envApiKey = process.env[`${providerId.toUpperCase()}_API_KEY`] || 
                    process.env[`${providerId.replace("-", "_").toUpperCase()}_API_KEY`] || ""
  
  const configApiKey = apiKeyConfig.providers?.[providerId]?.apiKey || ""
  
  const configs: Record<string, { name: string; baseURL: string; apiKey: string; headers?: Record<string, string> }> = {
    "opencode-zen": {
      name: "opencode-zen",
      baseURL: "https://opencode.ai/zen/v1",
      apiKey: "public",
      headers: {
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
        "x-opencode-session": `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
      },
    },
    anthropic: {
      name: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: envApiKey || configApiKey,
      headers: { "anthropic-version": "2023-06-01" },
    },
    openai: {
      name: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: envApiKey || configApiKey,
    },
    google: {
      name: "google",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: envApiKey || configApiKey,
    },
    deepseek: {
      name: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: envApiKey || configApiKey,
    },
    openrouter: {
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: envApiKey || configApiKey,
    },
    groq: {
      name: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: envApiKey || configApiKey,
    },
    ollama: {
      name: "ollama",
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    },
    "local-ai": {
      name: "local-ai",
      baseURL: "http://localhost:8080/v1",
      apiKey: "local-ai",
    },
  }

  return configs[providerId] || configs.openai
}