import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

export interface LogConfig {
  // Global switch
  enabled: boolean
  
  // Console output switches
  console: {
    request: boolean      // Log incoming requests
    response: boolean     // Log responses
    error: boolean        // Log errors
    toolCalls: boolean    // Log tool call details
    reasoning: boolean    // Log reasoning content
    headers: boolean      // Log request headers
    timing: boolean       // Log timing info
  }
  
  // File output switches
  file: {
    enabled: boolean
    path: string
    request: boolean
    response: boolean
    error: boolean
  }
  
  // Content filtering
  filter: {
    maxMessageLength: number    // Truncate messages longer than this
    maxReasoningLength: number  // Truncate reasoning longer than this
    sanitizeFields: string[]    // Fields to redact from logs
  }
}

const DEFAULT_CONFIG: LogConfig = {
  enabled: true,
  console: {
    request: true,
    response: true,
    error: true,
    toolCalls: true,
    reasoning: true,
    headers: false,
    timing: true,
  },
  file: {
    enabled: true,
    path: "logs/proxy.log",
    request: true,
    response: true,
    error: true,
  },
  filter: {
    maxMessageLength: 500,
    maxReasoningLength: 300,
    sanitizeFields: ["apiKey", "authorization"],
  },
}

export class LogManager {
  private config: LogConfig
  private configPath: string
  private listeners: Array<(config: LogConfig) => void> = []

  constructor(configPath?: string) {
    this.configPath = configPath || resolve(process.cwd(), "log-config.json")
    this.config = this.loadConfig()
  }

  private loadConfig(): LogConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, "utf-8")
        const loaded = JSON.parse(raw)
        // Merge with defaults to ensure all fields exist
        return this.mergeConfig(DEFAULT_CONFIG, loaded)
      }
    } catch (e) {
      console.error("[LogManager] Failed to load config, using defaults:", e)
    }
    return { ...DEFAULT_CONFIG }
  }

  private mergeConfig(base: LogConfig, override: Partial<LogConfig>): LogConfig {
    return {
      enabled: override.enabled ?? base.enabled,
      console: { ...base.console, ...override.console },
      file: { ...base.file, ...override.file },
      filter: { ...base.filter, ...override.filter },
    }
  }

  getConfig(): LogConfig {
    return { ...this.config }
  }

  updateConfig(patch: Partial<LogConfig>): LogConfig {
    this.config = this.mergeConfig(this.config, patch)
    this.saveConfig()
    this.notifyListeners()
    return this.getConfig()
  }

  updateConsoleSwitch(key: keyof LogConfig["console"], value: boolean): void {
    ;(this.config.console as any)[key] = value
    this.saveConfig()
    this.notifyListeners()
  }

  updateFileSwitch(key: keyof LogConfig["file"], value: boolean): void {
    ;(this.config.file as any)[key] = value
    this.saveConfig()
    this.notifyListeners()
  }

  private saveConfig(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    } catch (e) {
      console.error("[LogManager] Failed to save config:", e)
    }
  }

  onChange(listener: (config: LogConfig) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.config)
      } catch {}
    }
  }

  // Convenience methods for checking if logging is enabled
  shouldLog(category: keyof LogConfig["console"]): boolean {
    return this.config.enabled && this.config.console[category]
  }

  shouldLogToFile(category: "request" | "response" | "error"): boolean {
    return this.config.enabled && this.config.file.enabled && (this.config.file[category] as boolean)
  }

  truncate(str: string, maxLength?: number): string {
    const max = maxLength ?? this.config.filter.maxMessageLength
    if (!str || str.length <= max) return str
    return str.slice(0, max) + "...[truncated]"
  }

  truncateReasoning(str: string): string {
    return this.truncate(str, this.config.filter.maxReasoningLength)
  }

  sanitize(obj: any): any {
    if (!obj || typeof obj !== "object") return obj
    const sanitized = { ...obj }
    for (const key of Object.keys(sanitized)) {
      if (this.config.filter.sanitizeFields.includes(key.toLowerCase())) {
        sanitized[key] = "***REDACTED***"
      }
    }
    return sanitized
  }
}

// Singleton instance
let managerInstance: LogManager | null = null

export function getLogManager(): LogManager {
  if (!managerInstance) {
    managerInstance = new LogManager()
  }
  return managerInstance
}

export function resetLogManager(): void {
  managerInstance = null
}
