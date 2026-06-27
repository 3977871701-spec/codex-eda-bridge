# Codex EDA Bridge

让 Codex 或其他 AI Agent 通过 WebSocket 连接到嘉立创 EDA Pro 页面，远程执行 JavaScript 代码操控 `window.eda` / `window.api` 的本地桥接服务。

## 项目简介

Codex EDA Bridge 采用"路线 B"架构：AI Agent 不直接操作 EDA 界面（不使用视觉识别或 UI 自动化），而是通过本地 HTTP/WebSocket 桥接服务，将 JS 代码发送到已连接的 EDA 浏览器窗口中执行。这种方式实现了 Codex 与嘉立创 EDA Pro 的无缝集成，可用于自动化原理图绘制、PCB 布局、属性修改、铜皮创建等各类 EDA 操作。

核心工作流程：

```
Codex CLI ──(MCP/JSON-RPC)──> codex-eda-bridge ──(WebSocket)──> EDA Pro 浏览器窗口
                                  (本地服务)                       (注入 JS 代码)
```

## 功能特性

- **零依赖实现** — 纯 Node.js 原生 HTTP + WebSocket，无第三方运行时依赖
- **MCP 协议支持** — 内置 MCP (Model Context Protocol) 服务器，Codex 重启后自动注册工具集
- **HTTP REST API** — 提供 `/health`、`/eda-windows`、`/execute` 等标准接口
- **WebSocket 双通道** — `/eda` 端口连接 EDA 浏览器窗口，`/agent` 端口连接 AI Agent
- **多窗口管理** — 支持同时连接多个 EDA 窗口，可选择指定窗口执行代码
- **代码远程执行** — Agent 通过 Bridge 向 EDA 窗口发送 JS 代码并获取执行结果
- **自动重连** — EDA 端连接断开后自动尝试重连（2 秒间隔）
- **智能端口选择** — 49620-49629 端口范围内自动选择可用端口
- **代理模式** — 多实例场景下自动发现并代理到已有 Bridge
- **Token 认证** — 可选的 Token 鉴权机制，防止未授权访问
- **日志记录** — 完整调试日志写入文件 + 内存最近 30 条事件缓存

## 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                    codex-eda-bridge                         │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │  MCP Server  │    │  HTTP Server │    │ WS Server     │  │
│  │  (stdin/out) │    │  (REST API)  │    │ (/eda, /agent)│  │
│  └──────┬───────┘    └──────┬───────┘    └───────┬───────┘  │
│         │                   │                    │          │
│         └───────────────────┴────────────────────┘          │
│                             │                               │
│                    ┌────────┴────────┐                      │
│                    │  State Manager  │                      │
│                    │  - edaClients   │                      │
│                    │  - agentClients │                      │
│                    │  - pending      │                      │
│                    │  - recent       │                      │
│                    └─────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌─────────────────────┐
│   Codex CLI     │          │  EDA Pro 浏览器      │
│  (MCP Client)   │          │  + connect.js 注入   │
│                 │          │  window.eda / api    │
└─────────────────┘          └─────────────────────┘
```

### 运行模式

Bridge 支持两种运行模式：

1. **服务器模式（默认）** — 在端口范围 49620-49629 中找到第一个可用端口启动 HTTP/WebSocket 服务
2. **代理模式** — 检测到已有 Bridge 实例运行时，自动附加为代理客户端，转发请求到已有实例

### MCP 工具集

Bridge 作为 MCP 服务器运行时，向 Codex 注册以下工具：

| 工具名称 | 功能说明 |
|----------|----------|
| `eda_status` | 查看 Bridge 健康状态和已连接的 EDA 窗口数量 |
| `eda_windows` | 列出所有已连接的 EDA 窗口详情（ID、标题、URL、API Keys） |
| `eda_select_window` | 选择后续操作的目标 EDA 窗口 |
| `eda_api_overview` | 检查 EDA 窗口中 `window.eda` / `window.api` 的顶层 API 结构 |
| `eda_execute` | 在选定 EDA 窗口中执行任意 JavaScript 代码并返回结果 |

## API 接口

### HTTP REST API

| 方法 | 路径 | 说明 | 响应格式 |
|------|------|------|----------|
| `GET` | `/health` | 健康检查，返回 Bridge 状态、连接窗口数、最近事件 | JSON |
| `GET` | `/eda-windows` | 列出已连接的 EDA 窗口 | JSON |
| `POST` | `/eda-windows/select` | 选择指定 EDA 窗口。Body: `{"id": "window-id"}` | JSON |
| `POST` | `/execute` | 在 EDA 窗口执行 JS 代码。Body: `{"code": "...", "windowId": "?", "timeoutMs": ?}` | JSON |
| `GET` | `/connect.js` | 获取 EDA 端连接脚本（供浏览器注入使用） | JavaScript |
| `OPTIONS` | `*` | CORS 预检请求 | - |

### WebSocket 端点

| 路径 | 说明 | 消息协议 |
|------|------|----------|
| `ws://host:port/eda` | EDA 浏览器窗口连接端点 | 注册 → 执行 → 结果 |
| `ws://host:port/agent` | AI Agent 连接端点 | 执行请求 → 转发到 EDA |

#### EDA 端 WebSocket 消息协议

```jsonc
// 注册（EDA → Bridge）
{"type": "register", "id": "eda-xxx", "window": {"title": "...", "href": "...", "apiKeys": [...]}}

// 执行指令（Bridge → EDA）
{"type": "execute", "id": "uuid", "code": "return eda.pcb.getComponents()"}

// 执行结果（EDA → Bridge）
{"type": "result", "id": "uuid", "ok": true, "result": {...}}
{"type": "result", "id": "uuid", "ok": false, "error": "..."}

// 心跳
{"type": "ping", "id": "..."}  // → {"type": "pong", "id": "...", "timestamp": ...}
```

## 安装方法

### 环境要求

- Node.js >= 18

### 安装步骤

```bash
cd ~/codex-eda-bridge
npm install   # 无运行时依赖，仅用于 bin 命令注册
```

## 使用方法

### 1. 启动 Bridge

```bash
# 方式一：通过 npm
npm start

# 方式二：直接运行
node ./bin/codex-eda-bridge.mjs

# 方式三：健康检查（不启动服务）
npm run smoke
```

启动后输出：
```
[codex-eda-bridge] Bridge: http://127.0.0.1:49620
[codex-eda-bridge] EDA WS: ws://127.0.0.1:49620/eda
```

### 2. 连接 EDA Pro 端

#### 方式 A — 注入连接脚本（推荐）

在嘉立创 EDA Pro 的开发者控制台中执行：

```js
document.head.appendChild(Object.assign(document.createElement('script'), {
  src: 'http://127.0.0.1:49620/connect.js'
}));
```

或通过 Bridge 提供的 HTTP 接口获取脚本：

```bash
curl http://127.0.0.1:49620/connect.js | pbcopy
# 粘贴到 EDA 控制台执行
```

#### 方式 B — 使用 run-api-gateway 扩展

在嘉立创 EDA Pro 中启用 `run-api-gateway` 扩展，它会自动连接 `ws://127.0.0.1:49620/eda`。

### 3. 验证连接

```bash
# 查看 Bridge 状态
curl http://127.0.0.1:49620/health

# 列出已连接的 EDA 窗口
curl http://127.0.0.1:49620/eda-windows

# 在 EDA 窗口中执行测试代码
curl -X POST http://127.0.0.1:49620/execute \
  -H 'Content-Type: application/json' \
  -d '{"code": "return { ok: true, hasEda: typeof eda !== \"undefined\" }"}'
```

### 4. 在 Codex 中使用

将以下配置添加到 Codex 的 `config.toml`（参考 `codex-config-snippet.toml`）：

```toml
[mcp_servers.eda_bridge]
command = "/path/to/node"
args = ["/path/to/codex-eda-bridge/bin/codex-eda-bridge.mjs"]
startup_timeout_sec = 30

[mcp_servers.eda_bridge.env]
EDA_BRIDGE_HOST = "127.0.0.1"
EDA_BRIDGE_PORT_START = "49620"
EDA_BRIDGE_PORT_END = "49629"
```

重启 Codex 后，Agent 即可通过 `eda_execute` 等工具操控 EDA。例如：

- `eda_status` — 检查连接状态
- `eda_api_overview` — 探索 EDA API
- `eda_execute` — 执行 `eda.pcb.getComponents()` 等操作

## 与 EasyEDA Pro 的集成方式

### 连接原理

```
┌──────────────┐    浏览器注入     ┌──────────────────┐
│  codex-eda-  │◄─── connect.js ──│  EasyEDA Pro     │
│  bridge      │    WebSocket      │  浏览器页面       │
│  :49620      │◄────────────────│  window.eda      │
└──────┬───────┘                   │  window.api      │
       │                           └──────────────────┘
       │ MCP (stdin/stdout)
       ▼
┌──────────────┐
│  Codex CLI   │
│  (AI Agent)  │
└──────────────┘
```

### connect.js 注入脚本工作流程

1. `connect.js` 在 EDA 浏览器页面中创建 WebSocket 连接到 Bridge
2. 连接成功后发送 `register` 消息，包含窗口信息和可用 API Keys
3. 收到 Bridge 转发的 `execute` 消息时，通过 `new Function()` 在当前页面上下文中执行代码
4. 将执行结果（或错误）通过 WebSocket 返回给 Bridge
5. 连接断开时自动在 2 秒后重连

### EDA API 访问

代码在 EDA 窗口中执行时，可直接访问：

- `window.eda` / `globalThis.eda` — 嘉立创 EDA 核心 API
- `window.api` / `globalThis.api` — 扩展 API

通过 `eda_api_overview` 工具可枚举所有可用的顶层 API 及其子属性。

### 实际应用示例

以下为通过 Bridge 实现的典型 EDA 自动化操作：

1. **元件属性修复** — 批量读取 PCB 元件数据，分析属性问题，修改 Designator 字号、位置等参数
2. **铜皮区域创建** — 根据板框尺寸自动创建顶层/底层 GND 覆铜区域
3. **实时数据备份** — 周期性拉取 PCB 全量数据用于分析和存档
4. **设计验证** — 自动检查元件属性完整性、网络连接正确性

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EDA_BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `EDA_BRIDGE_PORT_START` | `49620` | 端口范围起始 |
| `EDA_BRIDGE_PORT_END` | `49629` | 端口范围结束 |
| `EDA_BRIDGE_PORT` | — | 同时设置起始和结束端口（覆盖 START/END） |
| `EDA_BRIDGE_TOKEN` | 空 | 认证 Token（为空则不鉴权） |
| `EDA_BRIDGE_FORCE_SERVER` | `false` | 设为 `1` 强制服务器模式（不代理到已有实例） |
| `EDA_BRIDGE_LOG` | `/tmp/codex-eda-bridge.log` | 日志文件路径 |

## 项目结构

```
codex-eda-bridge/
├── bin/
│   └── codex-eda-bridge.mjs          # 主入口：HTTP + WebSocket + MCP 服务器
├── eda-snippets/
│   └── connect.js                    # EDA 浏览器端注入连接脚本
├── package.json                      # 项目配置（零运行时依赖）
├── codex-config-snippet.toml         # Codex MCP 配置示例片段
├── config.toml.bak.before-eda-bridge # Codex 原始配置备份
├── bridge.log                        # 运行日志
└── README.md                         # 本文件
```

## 技术细节

- **协议版本**: MCP `2025-03-26`
- **WebSocket**: 手动实现（RFC 6455），包含帧编解码、掩码处理、Ping/Pong 心跳
- **端口选择**: 顺序尝试 49620-49629，使用第一个可用端口
- **消息大小限制**: HTTP 请求体上限 10MB
- **执行超时**: 默认 30 秒（可通过 `timeoutMs` 参数自定义）
- **输出截断**: 超过 8000 字符的执行结果自动截断（API Overview 为 12000）
