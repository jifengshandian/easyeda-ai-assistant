# MCP (Model Context Protocol) 集成指南

## 概述

EasyEDA AI 助手现已支持 MCP 工具调用，可通过 Gateway 调用外部工具（如搜索引擎、datasheet 查询等），大幅增强 AI 的原理图审查能力。

## 支持的 Gateway 类型

### 1. REST Gateway（自定义 REST API）

适用于自建的 HTTP REST Gateway。

**端点格式：**
- `POST /tools/list` - 获取工具列表
- `POST /tools/call` - 执行工具调用

**请求示例：**
```json
POST /tools/list
{
  "sessionId": "xxx",
  "requestId": "xxx"
}
```

**响应示例：**
```json
{
  "tools": [
    {
      "name": "search_datasheet",
      "description": "搜索芯片 datasheet",
      "inputSchema": { "type": "object", ... }
    }
  ]
}
```

### 2. MCP Streamable HTTP（JSON-RPC 2.0）

适用于标准 MCP 传输层，如 SuperGateway。

**端点格式：**
- 单一端点（如 `/mcp`）接收所有 JSON-RPC 请求

**请求示例：**
```json
POST /mcp
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "id": 1
}
```

**响应示例（SSE 格式）：**
```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
```

**会话管理：**
1. 首次请求发送 `initialize` 握手
2. 服务端返回 `Mcp-Session-Id` 响应头
3. 后续请求携带该 session ID

## 自动检测机制

代码会根据 Gateway URL 自动选择协议：

```typescript
// URL 以这些路径结尾 → JSON-RPC 模式
/mcp, /sse, /http, /streamable, /jsonrpc

// 其他 URL → REST 模式
```

**示例：**
- `http://gateway.com/mcp` → JSON-RPC
- `http://gateway.com/api` → REST

## 配置方法

### 使用 SuperGateway（推荐）

**1. 启动 SuperGateway**

```bash
# Stateful 模式（需要 session 管理）
npx -y supergateway \
  --stdio "npx -y @modelcontextprotocol/server-grok-search" \
  --outputTransport streamableHttp \
  --port 8000 \
  --stateful

# Stateless 模式（不需要 session 管理）
npx -y supergateway \
  --stdio "npx -y @modelcontextprotocol/server-grok-search" \
  --outputTransport streamableHttp \
  --port 8000
```

**2. 在 EasyEDA 中配置**

```
✅ MCP Enabled: 启用
📍 MCP Gateway URL: http://localhost:8000/mcp
🔑 MCP Gateway API Key: (留空)
⚡ MCP Auto Approve: 启用
⏱️ MCP Timeout: 30 秒
```

### 使用远程 SuperGateway

如果你已经部署了远程 SuperGateway：

```
✅ MCP Enabled: 启用
📍 MCP Gateway URL: http://104.224.159.186:55783/mcp
🔑 MCP Gateway API Key: (如果需要认证则填写)
⚡ MCP Auto Approve: 启用
⏱️ MCP Timeout: 30 秒
```

### 使用自建 REST Gateway

```
✅ MCP Enabled: 启用
📍 MCP Gateway URL: http://your-gateway.com/api
🔑 MCP Gateway API Key: your-api-key
⚡ MCP Auto Approve: 启用
⏱️ MCP Timeout: 30 秒
```

## 工作流程

### JSON-RPC 模式（SuperGateway）

```
1. 用户发起对话
   ↓
2. 扩展调用 listTools()
   ↓
3. 检测到 JSON-RPC 模式且未初始化
   ↓
4. 发送 initialize 请求（不带 session ID）
   POST /mcp
   {"jsonrpc":"2.0","method":"initialize","params":{...},"id":1}
   ↓
5. 服务端返回 Mcp-Session-Id 响应头
   Mcp-Session-Id: xxx-xxx-xxx
   ↓
6. 保存 session ID
   ↓
7. 发送 tools/list 请求（带 session ID）
   POST /mcp
   Headers: Mcp-Session-Id: xxx-xxx-xxx
   {"jsonrpc":"2.0","method":"tools/list","id":2}
   ↓
8. 返回工具列表
   ↓
9. AI 决定调用工具
   ↓
10. 发送 tools/call 请求（带 session ID）
    POST /mcp
    Headers: Mcp-Session-Id: xxx-xxx-xxx
    {"jsonrpc":"2.0","method":"tools/call","params":{...},"id":3}
    ↓
11. 返回工具执行结果
    ↓
12. AI 基于结果生成回答
```

### REST 模式

```
1. 用户发起对话
   ↓
2. 扩展调用 listTools()
   POST /tools/list
   {"sessionId":"xxx","requestId":"xxx"}
   ↓
3. 返回工具列表
   ↓
4. AI 决定调用工具
   ↓
5. 发送工具调用请求
   POST /tools/call
   {"name":"tool_name","arguments":{...}}
   ↓
6. 返回工具执行结果
   ↓
7. AI 基于结果生成回答
```

## UI 展示

### Tool Block（紫色主题）

工具调用会在对话中显示为紫色的 Tool Block：

**执行中：**
```
┌─────────────────────────────────────┐
│ 🔧 调用工具 web_search              │
│ ⏳ 执行中...                        │
│ 参数: {"query":"NE555 datasheet"}   │
└─────────────────────────────────────┘
```

**成功：**
```
┌─────────────────────────────────────┐
│ ✅ 工具 web_search 执行成功         │
│ 结果摘要: 找到 NE555 的完整...      │
│ [展开查看完整结果]                  │
└─────────────────────────────────────┘
```

**失败：**
```
┌─────────────────────────────────────┐
│ ❌ 工具 web_search 执行失败         │
│ 错误: Gateway 请求超时              │
└─────────────────────────────────────┘
```

### 调试日志

在调试面板中可以看到详细的 MCP 日志（紫色高亮）：

```
[MCP-Discovery] 开始获取工具列表
[MCP-Discovery] 已加载 8 个 MCP 工具
[MCP-Call] 调用工具 web_search { args: {...} }
[MCP-Exec] 工具执行完成 { status: 'success', duration: 1234 }
```

## 测试方法

### 1. 验证 Gateway 连接

**测试 JSON-RPC 模式：**
```bash
# 测试 initialize
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'

# 提取 Mcp-Session-Id 响应头
# 然后测试 tools/list
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <从上一步获取的 session ID>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

**测试 REST 模式：**
```bash
curl -X POST http://your-gateway.com/api/tools/list \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test","requestId":"test"}'
```

### 2. 在扩展中测试

1. **配置并保存**
2. **在对话中测试**：
   ```
   帮我查一下 NE555 的引脚定义
   ```
3. **查看调试日志**（应该看到）：
   ```
   [MCP-Discovery] 开始获取工具列表
   [MCP-Discovery] 已加载 X 个 MCP 工具
   [MCP-Call] 调用工具 web_search
   [MCP-Exec] 工具 web_search 执行成功
   ```
4. **在对话中看到紫色 Tool Block**

## 常见问题

### Q1: 报错 "No valid session ID provided"

**原因：** SuperGateway 使用 `--stateful` 模式启动，需要 session 管理。

**解决：** 代码已实现完整的 session 管理，确保：
1. Gateway URL 以 `/mcp` 结尾（触发 JSON-RPC 模式）
2. 重启扩展，让代码重新初始化

### Q2: 报错 "Not Acceptable: Client must accept both application/json and text/event-stream"

**原因：** 缺少正确的 Accept 头。

**解决：** 代码已自动添加该头，确保使用最新版本。

### Q3: 工具列表为空

**原因：** Gateway 未返回工具或响应格式不兼容。

**解决：**
1. 用 curl 测试 Gateway 端点
2. 检查响应格式是否符合 MCP 规范
3. 查看调试日志中的错误信息

### Q4: 工具调用超时

**原因：** 工具执行时间超过配置的超时时间。

**解决：** 增加 `MCP Timeout` 配置（默认 30 秒）。

### Q5: CORS 错误

**原因：** Gateway 未配置 CORS。

**解决：** 在 SuperGateway 启动时添加 `--cors` 标志：
```bash
npx -y supergateway \
  --stdio "..." \
  --outputTransport streamableHttp \
  --port 8000 \
  --cors
```

## 可用的 MCP Server

### Grok-search（推荐）

提供 8 个强大的搜索工具：

1. **web_search** - 深度网络搜索（带 Grok AI 回答）
2. **get_sources** - 获取搜索来源列表
3. **web_fetch** - 抓取完整网页内容（Markdown 格式）
4. **web_map** - 网站结构图谱遍历
5. **get_config_info** - 查看配置
6. **switch_model** - 切换 Grok 模型
7. **toggle_builtin_tools** - 控制内置工具
8. **search_planning** - 搜索规划脚手架

**启动方式：**
```bash
npx -y supergateway \
  --stdio "npx -y @modelcontextprotocol/server-grok-search" \
  --outputTransport streamableHttp \
  --port 8000 \
  --stateful
```

### Filesystem

访问本地文件系统（如 datasheet 文件夹）：

```bash
npx -y supergateway \
  --stdio "npx -y @modelcontextprotocol/server-filesystem /path/to/datasheets" \
  --outputTransport streamableHttp \
  --port 8000
```

### 更多 MCP Server

访问 [MCP Registry](https://modelcontextprotocol.io/registry) 查看所有可用的 MCP Server。

## 技术细节

### 代码架构

```
orchestrator.ts
  └─ ToolOrchestrator (tool-orchestrator.ts)
       ├─ detectGatewayType() - 自动检测 Gateway 类型
       ├─ ensureInitialized() - 确保 MCP 会话已初始化
       ├─ performInitialize() - 执行 initialize 握手
       ├─ listTools() - 获取工具列表
       ├─ executeToolCalls() - 执行工具调用
       └─ postJson() - 统一的 HTTP 请求封装
```

### 关键文件

| 文件 | 说明 |
|------|------|
| `src/review/tool-orchestrator.ts` | 工具编排器核心 |
| `src/review/orchestrator.ts` | 集成工具事件和配置 |
| `src/review/chat-adapter.ts` | 支持多轮工具调用 |
| `src/review/types.ts` | MCP 类型定义 |
| `src/review/config.ts` | MCP 配置管理 |
| `iframe/chat.html` | Tool Block UI |

### 提交历史

```bash
a900684 fix: 实现 MCP Streamable HTTP 会话管理
d063245 feat: 支持 MCP Streamable HTTP (JSON-RPC 2.0) 协议
bd21d3b feat: 实现 MCP (Model Context Protocol) 工具调用集成
```

## 参考资料

- [MCP 官方规范](https://modelcontextprotocol.io/specification/2025-03-26)
- [SuperGateway GitHub](https://github.com/supercorp-ai/supergateway)
- [MCP Registry](https://modelcontextprotocol.io/registry)
- [Grok-search MCP Server](https://github.com/guda-studio/mcp-server-grok-search)

## 贡献

欢迎提交 Issue 和 PR 来改进 MCP 集成功能！
