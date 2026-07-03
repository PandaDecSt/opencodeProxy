# OpenCode Free Model Proxy 技术文档

## 1. 项目背景

opencode 是一个开源 AI 编程助手，内置了多个免费模型（如 Big Pickle、DeepSeek V4 Flash、MiMo V2.5 等），这些模型通过 OpenCode Zen 服务提供，无需 API Key 即可使用。

**目标**：将 opencode 的免费模型能力暴露为标准 OpenAI 兼容的 HTTP 端口，供另一个支持本地模型调用的 agent 使用。

```
[另一个 Agent] → [本地代理 :9090/v1] → [OpenCode Zen 免费端点] → [各大免费模型]
```

---

## 2. 研究过程

### 2.1 分析 opencode 源码

首先克隆 opencode 仓库，分析其架构：

- `packages/opencode/src/provider/provider.ts` - Provider 服务，管理模型和 provider 映射
- `packages/opencode/src/session/llm.ts` - LLM 调用，使用 AI SDK 的 `streamText`/`generateText`
- `packages/opencode/src/provider/models.ts` - 模型定义，从 models.dev 获取模型列表

**关键发现**：opencode 使用 AI SDK（`@ai-sdk/*`）作为底层模型调用框架，Provider 服务返回 `LanguageModelV3` 接口，可直接用于 AI SDK 的 `streamText`/`generateText`。

### 2.2 发现 Zen API

通过 web 搜索发现 OpenCode Zen 是 opencode 团队提供的免费模型服务：

- **端点**：`https://opencode.ai/zen/v1`
- **认证**：无需 API Key，但需要特殊的 `x-opencode-*` 请求头
- **免费模型**：Big Pickle、DeepSeek V4 Flash Free、MiMo V2.5 Free 等

关键发现来自 [opencode-free-proxy](https://github.com/bigdata2211it-web/opencode-free-proxy) 项目，该项目通过逆向工程发现了 Zen API 所需的认证头。

### 2.3 Zen API 认证机制

Zen API 不接受标准的 Bearer Token，而是需要以下头部：

```
Authorization: Bearer public
x-opencode-client: cli
x-opencode-project: global
x-opencode-request: msg_<unique_id>
x-opencode-session: ses_<unique_id>
```

这些头部是通过逆向分析 opencode 二进制文件发现的，缺少任何一个都会导致认证失败。

---

## 3. 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    OpenCode Free Model Proxy             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │ HTTP Server │───▶│ Request      │───▶│ Provider   │ │
│  │ :9090       │    │ Handler      │    │ Client     │ │
│  └─────────────┘    └──────────────┘    └────────────┘ │
│        │                  │                   │         │
│        ▼                  ▼                   ▼         │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │ /v1/models │    │ /v1/chat/    │    │ AI SDK     │ │
│  │ /v1/chat/  │    │ completions  │    │ OpenAI     │ │
│  │ completions│    │              │    │ Compatible │ │
│  └─────────────┘    └──────────────┘    └────────────┘ │
│                                                         │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              OpenCode Zen API                           │
│  https://opencode.ai/zen/v1                             │
│  认证: Bearer public + x-opencode-* 头部                 │
└─────────────────────────────────────────────────────────┘
```

### 核心模块

| 模块 | 职责 |
|------|------|
| `server.ts` | HTTP 服务器，路由请求 |
| `handlers.ts` | 处理 `/v1/chat/completions` 和 `/v1/models` |
| `provider.ts` | AI SDK Provider 配置，管理 API Key 和头部 |
| `config.ts` | 配置文件加载和模型映射 |
| `types.ts` | OpenAI 兼容的类型定义 |

---

## 4. 遇到的问题与解决方案

### 4.1 问题：端口占用 (EADDRINUSE)

**现象**：启动时报错 `Error: listen EADDRINUSE: address already in use 127.0.0.1:8080`

**原因**：之前的进程未正确关闭

**解决**：
```powershell
# 查找占用端口的进程
Get-NetTCPConnection -LocalPort 8080

# 强制关闭
Stop-Process -Name node -Force
```

**最终方案**：将默认端口改为 9090，避免与其他服务冲突。

---

### 4.2 问题：TypeScript 编译错误 - AI SDK 类型不兼容

**现象**：编译时报错 `Module '"ai"' has no exported member 'CoreMessage'`

**原因**：AI SDK v5 改变了导出的类型名称

**解决方案**：
1. 将 `CoreMessage` 改为 `UIMessage`
2. 将 `maxTokens` 参数改为 `maxOutputTokens`
3. 将 `promptTokens`/`completionTokens` 改为 `inputTokens`/`outputTokens`
4. 最终为了简化，使用 `any` 类型绕过类型检查

---

### 4.3 问题：免费模型返回空内容

**现象**：请求成功但 `content` 字段为空

**原因**：Zen API 返回的 thinking 模型（如 Big Pickle）将思考过程放在 `reasoning_content` 字段，而实际回答在 `content` 字段。由于 `max_tokens` 太小，模型只输出了思考过程就被截断了。

**解决方案**：
1. 增大 `max_tokens` 到 200+
2. 在响应中同时返回 `reasoning` 字段

```typescript
message: {
  role: "assistant",
  content: result.text || "",
  reasoning: result.reasoning || undefined,  // 新增
}
```

---

### 4.4 问题：Zen API 认证失败

**现象**：`AI_APICallError: Invalid API key`

**原因**：Zen API 不接受标准的 Bearer Token 认证，需要特殊的 `x-opencode-*` 头部

**解决方案**：参考 [opencode-free-proxy](https://github.com/bigdata2211it-web/opencode-free-proxy) 项目，添加以下头部：

```typescript
headers: {
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-request": `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
  "x-opencode-session": `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
}
```

---

### 4.5 问题：模型映射 ID 不匹配

**现象**：配置的模型 ID（如 `glm-4.7-free`）在 Zen API 中不存在

**原因**：opencode 文档中的模型列表与实际 API 返回的模型列表不一致

**解决方案**：调用 Zen API 的 `/v1/models` 端点获取实际可用的模型列表：

```bash
curl https://opencode.ai/zen/v1/models -H "Authorization: Bearer public"
```

最终使用的免费模型 ID：
- `big-pickle`
- `deepseek-v4-flash-free`
- `mimo-v2.5-free`
- `nemotron-3-ultra-free`
- `north-mini-code-free`
- `gpt-5-nano`
- `deepseek-v4-flash`

---

### 4.6 问题：工具调用返回空参数

**现象**：模型正确识别需要调用工具，但返回的 `arguments` 为空对象 `{}`

**根因分析**（经调试确认）：

1. **AI SDK 修改工具参数格式**：AI SDK 在发送请求前，将工具的 `parameters` 转换为 strict schema 格式，原来的 `properties: {"city": {...}}` 被清空为 `properties: {}`，并添加 `additionalProperties: false`。Zen API 收到空参数后，模型无法获取参数定义，自然返回空参数。

2. **AI SDK 返回字段名不一致**：AI SDK 内部使用 `input` 字段存储工具参数（不是 `args`），导致响应转换时使用了错误的字段名。

**解决方案**：

1. **Fetch 拦截器恢复原始工具定义**（`src/provider.ts`）：
   ```typescript
   // 存储原始工具定义
   const originalToolDefs = new Map<string, any>()
   
   // 拦截 fetch，在发送前恢复原始定义
   globalThis.fetch = async function(...args) {
     if (url.includes('/chat/completions') && body.tools) {
       body.tools = body.tools.map(tool => 
         originalToolDefs.get(tool.function.name) || tool
       )
     }
     return originalFetch.apply(this, args)
   }
   ```

2. **修正响应字段名**（`src/handlers.ts`）：
   ```typescript
   // 错误：tc.args（AI SDK 不使用此字段）
   // 正确：tc.input（AI SDK 实际返回的字段）
   arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {})
   ```

**验证结果**：
```json
{
  "tool_calls": [{
    "function": {
      "name": "get_weather",
      "arguments": "{\"city\":\"Tokyo\"}"  // 正确返回参数
    }
  }]
}
```

---

### 4.7 问题：AI SDK v5 消息格式不兼容

**现象**：`InvalidPromptError: The messages do not match the ModelMessage[] schema`

**原因**：AI SDK v5 使用全新的消息格式，与 OpenAI 格式不兼容：

| 角色 | OpenAI 格式 | AI SDK v5 格式 |
|------|------------|----------------|
| assistant (tool_calls) | `{role, content, tool_calls: [{id, function: {name, arguments}}]}` | `{role, content: [{type: "tool-call", toolCallId, toolName, input}]}` |
| tool | `{role, tool_call_id, content: string}` | `{role, content: [{type: "tool-result", toolCallId, toolName, output: {type: "text", value}}]}` |
| assistant (reasoning) | `{role, content, reasoning: [{type, text}]}` | `{role, content: [{type: "reasoning", text}, {type: "text", text}]}` |

**解决方案**：在 `convertMessages` 中进行格式转换：

```typescript
// Tool messages: string content → output: {type: "text", value: string}
// Assistant messages: tool_calls array → content array with tool-call parts
// Reasoning: reasoning array → content array with reasoning parts
```

**关键细节**：
- `output` 必须是 `{type: "text", value: string}` 格式，不能直接用字符串
- `inputSchema` 必须用 `jsonSchema()` 包装，不能直接传 JSON 对象
- Thinking 模型要求在后续请求中返回 `reasoning_content`

---

## 5. 调试方法论

### 5.1 核心思路：分层定位 + 对比实验

当遇到"代理层转换后结果异常"的问题时，采用以下方法：

#### 第一步：确认原生 API 是否正常

```python
# 直接调用 Zen API，绕过代理
requests.post('https://opencode.ai/zen/v1/chat/completions', 
  json=payload, headers=headers)
```

**目的**：区分是"模型本身问题"还是"代理层引入的问题"

- 如果原生调用正常 → 问题在代理层
- 如果原生调用也异常 → 问题在模型/API 本身

#### 第二步：对比请求差异

```python
# 代理发送的请求 vs 原生请求
# 关注：headers、body 格式、字段名
```

**关键发现**：代理请求多了 `tool_choice: "auto"`，工具参数被 AI SDK 重新格式化

#### 第三步：在关键节点插入日志

```typescript
// 1. 入口：记录收到的原始请求
logger.logRequest(body)

// 2. 转换层：记录 AI SDK 返回的结果
debugLog(`result.toolCalls: ${JSON.stringify(result.toolCalls)}`)

// 3. 出口：记录最终发送的请求
// 在 fetch 拦截器中记录
debugLog(`Tools before fix: ${JSON.stringify(body.tools)}`)
debugLog(`Tools after fix: ${JSON.stringify(body.tools)}`)
```

#### 第四步：二分法缩小范围

```
[客户端请求] 
  → [代理接收] ✓
  → [转换为 AI SDK 格式] ← 问题在这里
  → [AI SDK 调用 API]
  → [API 返回]
  → [转换为 OpenAI 格式] ← 问题也在这里
  → [返回客户端]
```

### 5.2 调试工具选择

| 场景 | 工具 | 原因 |
|------|------|------|
| 查看请求/响应 | `proxy.log`（request/response hooks） | 全量记录，不影响主流程 |
| 查看内部状态 | `fetch_debug.log`（fetch 拦截器） | 能看到 AI SDK 实际发送的内容 |
| 查看 AI SDK 输出 | `handler_debug.log`（generateText 结果） | 能看到 `input` vs `args` 的差异 |

### 5.3 关键经验

1. **不要假设第三方库的行为**：AI SDK 文档说返回 `args`，实际返回 `input`
2. **拦截器是调试利器**：`globalThis.fetch` 拦截器能穿透 AI SDK 的封装，看到真实请求
3. **对比实验是金标准**：原生 API 调用成功 = 代理层引入了 bug
4. **日志要分层**：入口日志、转换日志、出口日志分开记录，便于定位

---

## 6. 使用方法

### 6.1 启动代理

```bash
cd opencodeProxy
npm install
npm run build
npm start
```

### 6.2 配置另一个 agent

```json
{
  "baseURL": "http://127.0.0.1:9090/v1",
  "apiKey": "not-needed",
  "model": "big-pickle"
}
```

### 6.3 测试

```bash
# 测试模型列表
curl http://127.0.0.1:9090/v1/models

# 测试聊天
curl -X POST http://127.0.0.1:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"What is 2+2?"}],"max_tokens":200}'

# 测试工具调用
curl -X POST http://127.0.0.1:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "max_tokens": 400
  }'
```

---

## 7. 配置文件说明

`opencode-proxy.json` 示例：

```json
{
  "port": 9090,
  "host": "127.0.0.1",
  "defaultModel": "big-pickle",
  "modelMappings": [
    {
      "externalId": "big-pickle",
      "providerId": "opencode-zen",
      "modelId": "big-pickle",
      "displayName": "Big Pickle (Free)"
    }
  ],
  "providers": {
    "opencode-zen": { "apiKey": "" }
  }
}
```

### 配置项说明

| 字段 | 说明 |
|------|------|
| `port` | 代理监听端口 |
| `host` | 监听地址 |
| `defaultModel` | 默认模型 ID |
| `modelMappings` | 模型映射表 |
| `providers` | Provider 配置（可选 API Key） |

---

## 8. 扩展：添加更多 Provider

如果需要添加其他付费 Provider（如 OpenAI、Anthropic），只需在 `opencode-proxy.json` 的 `providers` 中添加：

```json
{
  "providers": {
    "openai": { "apiKey": "sk-xxx" },
    "anthropic": { "apiKey": "sk-ant-xxx" }
  }
}
```

然后在 `modelMappings` 中添加对应模型：

```json
{
  "modelMappings": [
    { "externalId": "gpt-4o", "providerId": "openai", "modelId": "gpt-4o" }
  ]
}
```

---

## 9. 已知限制

1. **速率限制**：免费模型有 IP 级别的请求限制
2. **Thinking 模型**：部分模型返回思考过程（reasoning），需要客户端处理
3. **流式响应**：已支持，但未完全测试
4. **工具调用**：✅ 已支持（通过 fetch 拦截器恢复原始工具定义）

---

## 10. 参考资源

- [OpenCode 仓库](https://github.com/anomalyco/opencode)
- [OpenCode Zen 文档](https://opencode.ai/docs/zen/)
- [opencode-free-proxy](https://github.com/bigdata2211it-web/opencode-free-proxy)
- [AI SDK 文档](https://sdk.vercel.ai/docs)
