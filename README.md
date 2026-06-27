# Codex EDA Bridge

按 `codex接入ead.docx` 的路线 B 配置：Codex 不直接点嘉立创 EDA 界面，而是通过本地 Bridge/Gateway 把 JS 送进拥有 `window.eda` 的 EDA 窗口执行。

## 已实现的本地接口

- `GET /health`
- `GET /eda-windows`
- `POST /eda-windows/select`
- `POST /execute`
- `WS /eda`
- `WS /agent`

端口范围默认是文档里的 `49620-49629`。启动后会占用第一个可用端口，通常是 `http://127.0.0.1:49620`。

## Codex 工具

重启 Codex 后会出现 `eda_bridge` MCP 工具：

- `eda_status`：查看 Bridge 和 EDA 窗口连接状态。
- `eda_windows`：列出已连接的 EDA 窗口。
- `eda_select_window`：选择要操作的 EDA 窗口。
- `eda_api_overview`：读取 `window.eda` / `window.api` 顶层 API。
- `eda_execute`：在 EDA 窗口执行 JS。

## EDA 端连接

优先使用文档中提到的 `run-api-gateway` 扩展连接 `ws://127.0.0.1:49620/eda`。

如果没有该扩展，可以在嘉立创 EDA Pro 的页面控制台或扩展脚本环境里运行：

```text
/Users/xylei/codex-eda-bridge/eda-snippets/connect.js
```

或者在 EDA 页面控制台粘贴这一行：

```js
document.head.appendChild(Object.assign(document.createElement('script'), { src: 'http://127.0.0.1:49620/connect.js' }));
```

连接成功后，`eda_status` 里的 `edaWindowCount` 应该大于 0。

## 调试

```bash
curl http://127.0.0.1:49620/health
curl http://127.0.0.1:49620/eda-windows
```

测试执行：

```bash
curl -X POST http://127.0.0.1:49620/execute \
  -H 'Content-Type: application/json' \
  -d '{"code":"return { ok: true, hasEda: typeof eda !== \"undefined\" }"}'
```
