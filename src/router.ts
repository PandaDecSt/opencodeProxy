import { IncomingMessage, ServerResponse } from "node:http"

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS"

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: Record<string, string>
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

interface Route {
  method: HttpMethod | "*"
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
}

export class Router {
  private routes: Route[] = []

  private addRoute(method: HttpMethod | "*", path: string, handler: RouteHandler) {
    const paramNames: string[] = []
    // Support wildcard * at the end of path
    const isWildcard = path.endsWith("/*")
    const cleanPath = isWildcard ? path.slice(0, -2) : path
    
    const patternStr = cleanPath.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name)
      return "([^/]+)"
    })
    
    // Build regex: exact match or prefix match for wildcards
    const pattern = isWildcard
      ? new RegExp(`^${patternStr}(/.*)?$`)
      : new RegExp(`^${patternStr}$`)
    
    this.routes.push({ method, pattern, paramNames, handler })
  }

  get(path: string, handler: RouteHandler) {
    this.addRoute("GET", path, handler)
    return this
  }

  post(path: string, handler: RouteHandler) {
    this.addRoute("POST", path, handler)
    return this
  }

  put(path: string, handler: RouteHandler) {
    this.addRoute("PUT", path, handler)
    return this
  }

  delete(path: string, handler: RouteHandler) {
    this.addRoute("DELETE", path, handler)
    return this
  }

  all(path: string, handler: RouteHandler) {
    this.addRoute("*", path, handler)
    return this
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const method = (req.method?.toUpperCase() || "GET") as HttpMethod
    const pathname = url.pathname

    // Parse query params
    const query: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      query[key] = value
    })

    for (const route of this.routes) {
      if (route.method !== "*" && route.method !== method) continue

      const match = pathname.match(route.pattern)
      if (!match) continue

      // Extract params
      const params: Record<string, string> = {}
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1])
      })

      try {
        await route.handler({ req, res, params, query })
      } catch (error) {
        throw error
      }

      return true // Route matched and handled
    }

    return false // No route matched
  }
}
