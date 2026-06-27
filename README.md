# Codex EDA Bridge

一个本地 Bridge/Gateway 服务，让 Codex（或其他 AI Agent）能够通过 WebSocket 连接到嘉立创 EDA Pro 页面，在 EDA 窗口中远程执行 JavaScript 代码，实现对 `window.eda` / `window.api` 的自动化操控。

## 项目简介

Codex EDA Bridge 采用"路线 B"架构：AI Agent 不直接操作 EDA 界面，而是通过本地 HTTP/WebSocket 桥接服务，将 JS 代码发送到已连接的 EDA 浏览器窗口中执行。这种方式实现了 Codex 与嘉立创 EDA Pro 的无缝集成，可用于自动化原理图绘制、PCB 布局等 EDA 操作。

## 功能特性

- **HTTP REST API** — 提供 `/health`、`/eda-windows`、`/execute` 等标准接口
- **WebSocket 双通道** — `/eda` 端口连接 EDA 浏览器窗口，`/agent` 端口连接 AI Agent
- **多窗口管理** — 支持同时连接多个 EDA 窗口，可选择指定窗口执行代码
- **代码远程执行** — Agent 通过 Bridge 向 EDA 窗口发送 JS 代码并获取执行结果
- **自动重连** — EDA 端连接断开后自动尝试重连
- **Token 认证** — 可选的 Token 鉴权机制，防止未授权访问
- **MCP 工具集成** — 重启 Codex 后自动注册 `eda_bridge` MCP 工具集
- **日志记录** — 完整的调试日志写入 `/tmp/codex-eda-bridge.log`

## Codex MCP 工具

Bridge 启动后，Codex 会获得以下 MCP 工具：

| 工具 | 功能 |
|------|------|
| `eda_status` | 查看 Bridge 和 EDA 窗口连接状态 |
| `eda_windows` | 列出已连接的 EDA 窗口 |
| `eda_select_window` | 选择要操作的 EDA 窗口 |
| `eda_api_overview` | 读取 `window.eda` / `window.api` 顶层 API |
| `eda_execute` | 在 EDA 窗口执行 JS 代码 |

## 技术栈

- **运行时**: Node.js >= 18（原生 ESM 模块）
- **协议**: HTTP + WebSocket（手动实现，无第三方依赖）
- **端口范围**: 49620-49629（自动选择第一个可用端口）
- **日志**: 文件日志 + 内存最近事件缓存

## 安装方法

```bash
cd ~/codex-eda-bridge
npm install   # 无运行时依赖，仅为 bin 注册
```

## 使用方法

### 1. 启动 Bridge

```bash
npm start
# 或直接运行
node ./bin/codex-eda-bridge.mjs
```

默认监听 `http://127.0.0.1:49620`

### 2. 连接 EDA 端

**方式 A — 使用 run-api-gateway 扩展（推荐）**

在嘉立创 EDA Pro 中启用 `run-api-gateway` 扩展，自动连接 `ws://127.0.0.1:49620/eda`。

**方式 B — 注入连接脚本**

在 EDA 页面控制台中粘贴执行：

```js
document.head.appendChild(Object.assign(document.createElement('script'), {
  src: 'http://127.0.0.1:49620/connect.js'
}));
```

或直接运行本地连接脚本：

```bash
# 将 eda-snippets/connect.js 的内容粘贴到 EDA 控制台
```

### 3. 验证连接

```bash
# 健康检查
curl http://127.0.0.1:49620/health

# 查看已连接的 EDA 窗口
curl http://127.0.0.1:49620/eda-windows

# 测试执行
curl -X POST http://127.0.0.1:49620/execute \
  -H 'Content-Type: application/json' \
  -d '{"code":"return { ok: true, hasEda: typeof eda !== \"undefined\" }"}'
```

连接成功后，`eda_status` 中的 `edaWindowCount` 应大于 0。

### 4. 在 Codex 中使用

重启 Codex 后，通过 `eda_bridge` 工具集与 EDA 交互。例如：
- 调用 `eda_execute` 在 EDA 中绘制元件、布线
- 调用 `eda_api_overview` 了解可用的 EDA API

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EDA_BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `EDA_BRIDGE_PORT_START` | `49620` | 端口范围起始 |
| `EDA_BRIDGE_PORT_END` | `49629` | 端口范围结束 |
| `EDA_BRIDGE_TOKEN` | 空 | 认证 Token（为空则不鉴权） |
| `EDA_BRIDGE_LOG` | `/tmp/codex-eda-bridge.log` | 日志文件路径 |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查与状态 |
| GET | `/eda-windows` | 列出已连接的 EDA 窗口 |
| POST | `/eda-windows/select` | 选择指定 EDA 窗口 |
| POST | `/execute` | 在 EDA 窗口执行 JS 代码 |
| GET | `/connect.js` | EDA 端连接脚本 |
| WS | `/eda` | EDA 浏览器 WebSocket 端点 |
| WS | `/agent` | Agent 客户端 WebSocket 端点 |

## 项目结构

```
codex-eda-bridge/
├── bin/
│   └── codex-eda-bridge.mjs    # 主入口（HTTP+WS 服务器）
├── eda-snippets/
│   └── connect.js              # EDA 端注入连接脚本
├── package.json
├── codex-config-snippet.toml   # Codex 配置片段
├── bridge.log                  # 运行日志
└── config.toml.bak.before-eda-bridge  # 备份配置
```
