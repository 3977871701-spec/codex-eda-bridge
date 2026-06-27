#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

const HOST = process.env.EDA_BRIDGE_HOST || '127.0.0.1';
const PORT_START = Number(process.env.EDA_BRIDGE_PORT_START || process.env.EDA_BRIDGE_PORT || 49620);
const PORT_END = Number(process.env.EDA_BRIDGE_PORT_END || process.env.EDA_BRIDGE_PORT || 49629);
const TOKEN = process.env.EDA_BRIDGE_TOKEN || '';
const FORCE_SERVER = process.env.EDA_BRIDGE_FORCE_SERVER === '1';
const PROTOCOL_VERSION = '2025-03-26';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const LOG_PATH = process.env.EDA_BRIDGE_LOG || '/tmp/codex-eda-bridge.log';

const state = {
  actualPort: null,
  proxyBaseUrl: null,
  startedAt: new Date().toISOString(),
  edaClients: new Map(),
  agentClients: new Set(),
  selectedWindowId: null,
  pending: new Map(),
  recent: []
};

function remember(entry) {
  state.recent.unshift({ time: new Date().toISOString(), ...entry });
  state.recent = state.recent.slice(0, 30);
}

function debugLog(event, payload = {}) {
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), event, ...payload })}\n`);
  } catch {
    // Logging is best effort; the bridge must keep working if the file is unavailable.
  }
}

function clientSummary(client) {
  return {
    id: client.id,
    kind: client.kind,
    title: client.title,
    href: client.href,
    userAgent: client.userAgent,
    apiKeys: client.apiKeys,
    connectedAt: client.connectedAt,
    lastSeenAt: client.lastSeenAt
  };
}

function bridgeBaseUrl() {
  if (state.proxyBaseUrl) return state.proxyBaseUrl;
  return state.actualPort ? `http://${HOST}:${state.actualPort}` : null;
}

function statusPayload() {
  const windows = [...state.edaClients.values()].map(clientSummary);
  return {
    ok: true,
    bridge: 'easyeda-bridge',
    name: 'easyeda-bridge',
    type: 'easyeda-bridge',
    service: 'easyeda-bridge',
    version: '0.2.0-codex',
    baseUrl: bridgeBaseUrl(),
    portRange: `${PORT_START}-${PORT_END}`,
    edaWindowCount: windows.length,
    agentClientCount: state.agentClients.size,
    selectedWindowId: state.selectedWindowId,
    windows,
    pending: state.pending.size,
    startedAt: state.startedAt,
    recent: state.recent
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000_000) {
        req.destroy(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-eda-bridge-token',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function javascript(res, status, source) {
  res.writeHead(status, {
    'content-type': 'application/javascript; charset=utf-8',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(source)
  });
  res.end(source);
}

function checkToken(req, url) {
  if (!TOKEN) return true;
  return req.headers['x-eda-bridge-token'] === TOKEN || url.searchParams.get('token') === TOKEN;
}

function compact(value, maxChars = 8000) {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}\n... truncated ${value.length - maxChars} chars` : value;
  }
  const text = JSON.stringify(value, null, 2);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... truncated ${text.length - maxChars} chars` : text;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(value?.error || `HTTP ${response.status} from ${url}`);
  }
  return value;
}

async function proxyRequest(method, path, body) {
  if (!state.proxyBaseUrl) throw new Error('Bridge proxy is not attached');
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers['x-eda-bridge-token'] = TOKEN;
  return await fetchJson(`${state.proxyBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function findExistingBridge() {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    try {
      const headers = TOKEN ? { 'x-eda-bridge-token': TOKEN } : undefined;
      const value = await fetchJson(`http://${HOST}:${port}/health`, { headers });
      if (value?.service === 'easyeda-bridge' || value?.bridge === 'easyeda-bridge') {
        return { port, baseUrl: `http://${HOST}:${port}` };
      }
    } catch {
      // Try the next port.
    }
  }
  return null;
}

function selectedClient(windowId) {
  if (windowId) return state.edaClients.get(windowId);
  const selected = state.selectedWindowId ? state.edaClients.get(state.selectedWindowId) : null;
  if (selected?.kind === 'run-api-gateway') {
    return selected;
  }
  const gateway = [...state.edaClients.values()].find(client => client.kind === 'run-api-gateway');
  if (gateway) return gateway;
  if (selected) return selected;
  return state.edaClients.values().next().value;
}

function executeInEda({ code, windowId, timeoutMs = 30_000 }) {
  const client = selectedClient(windowId);
  if (!client) {
    throw new Error('No EDA window connected. Open JLC EDA Pro and enable run-api-gateway or paste eda-snippets/connect.js into the EDA page.');
  }

  const id = randomUUID();
  const payload = {
    type: 'execute',
    action: 'execute',
    id,
    requestId: id,
    code: String(code || ''),
    createdAt: Date.now()
  };

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`EDA execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    state.pending.set(id, {
      resolve: value => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      }
    });
  });

  sendWs(client.socket, payload);
  remember({ event: 'execute', id, windowId: client.id });
  return promise;
}

async function handleHttp(req, res) {
  const url = new URL(req.url, `http://${HOST}:${state.actualPort || PORT_START}`);

  if (req.method === 'OPTIONS') {
    return json(res, 204, {});
  }
  if (!checkToken(req, url)) {
    return json(res, 401, { ok: false, error: 'Bad or missing EDA bridge token' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/connect.js') {
      const source = readFileSync(new URL('../eda-snippets/connect.js', import.meta.url), 'utf8');
      return javascript(res, 200, source);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, statusPayload());
    }

    if (req.method === 'GET' && url.pathname === '/eda-windows') {
      return json(res, 200, {
        ok: true,
        selectedWindowId: state.selectedWindowId,
        windows: [...state.edaClients.values()].map(clientSummary)
      });
    }

    if (req.method === 'POST' && url.pathname === '/eda-windows/select') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!state.edaClients.has(body.id)) {
        return json(res, 404, { ok: false, error: `EDA window not found: ${body.id}` });
      }
      state.selectedWindowId = body.id;
      remember({ event: 'select-window', windowId: body.id });
      return json(res, 200, { ok: true, selectedWindowId: state.selectedWindowId });
    }

    if (req.method === 'POST' && url.pathname === '/execute') {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await executeInEda({
        code: body.code,
        windowId: body.windowId,
        timeoutMs: body.timeoutMs
      });
      return json(res, 200, { ok: true, result });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || String(error) });
  }
}

function websocketAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text);
  const header = [];
  header.push(0x81);
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, (payload.length >> 8) & 255, payload.length & 255);
  } else {
    header.push(127, 0, 0, 0, 0);
    header.push((payload.length / 2 ** 24) & 255, (payload.length / 2 ** 16) & 255, (payload.length / 2 ** 8) & 255, payload.length & 255);
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

function sendWs(socket, value) {
  if (!socket.destroyed) {
    socket.write(encodeWsFrame(JSON.stringify(value)));
  }
}

function parseWsFramesSafe(socket, chunk, onMessage) {
  socket._wsBuffer = socket._wsBuffer ? Buffer.concat([socket._wsBuffer, chunk]) : chunk;

  while (socket._wsBuffer.length >= 2) {
    const first = socket._wsBuffer[0];
    const second = socket._wsBuffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (socket._wsBuffer.length < offset + 2) return;
      length = socket._wsBuffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (socket._wsBuffer.length < offset + 8) return;
      const high = socket._wsBuffer.readUInt32BE(offset);
      const low = socket._wsBuffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    let mask;
    if (masked) {
      if (socket._wsBuffer.length < offset + 4) return;
      mask = socket._wsBuffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (socket._wsBuffer.length < offset + length) return;

    const payload = Buffer.from(socket._wsBuffer.subarray(offset, offset + length));
    socket._wsBuffer = socket._wsBuffer.subarray(offset + length);

    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00]));
      continue;
    }
    if (opcode !== 0x1) continue;

    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }
    onMessage(payload.toString('utf8'));
  }
}

function handleEdaMessage(socket, text) {
  debugLog('eda-message', { socketId: socket._edaId || null, text: text.slice(0, 1000) });
  const msg = JSON.parse(text);
  if (msg.type === 'ping') {
    sendWs(socket, {
      type: 'pong',
      id: msg.id,
      timestamp: Date.now()
    });
    return;
  }

  if (msg.type === 'register' || msg.type === 'hello' || msg.type === 'handshake' || msg.role === 'eda') {
    const id = msg.windowId || msg.id || msg.window?.id || randomUUID();
    const kind = msg.windowId && !msg.window ? 'run-api-gateway' : 'browser-injection';
    const client = {
      id,
      kind,
      socket,
      title: msg.window?.title || '',
      href: msg.window?.href || '',
      userAgent: msg.window?.userAgent || '',
      apiKeys: msg.window?.apiKeys || [],
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    socket._edaId = id;
    state.edaClients.set(id, client);
    if (!state.selectedWindowId || kind === 'run-api-gateway') state.selectedWindowId = id;
    remember({ event: 'eda-register', windowId: id, title: client.title });
    sendWs(socket, {
      type: 'registered',
      action: 'registered',
      ok: true,
      id,
      clientId: id,
      bridge: 'easyeda-bridge',
      baseUrl: bridgeBaseUrl()
    });
    return;
  }

  if (socket._edaId && state.edaClients.has(socket._edaId)) {
    state.edaClients.get(socket._edaId).lastSeenAt = new Date().toISOString();
  }

  if (msg.type === 'result' || msg.type === 'executeResult' || msg.action === 'result') {
    const resultId = msg.id || msg.requestId;
    const pending = state.pending.get(resultId);
    if (!pending) return;
    state.pending.delete(resultId);
    remember({ event: 'eda-result', id: resultId, ok: msg.ok !== false && msg.success !== false });
    if (msg.ok === false || msg.success === false) {
      pending.reject(new Error(msg.error || 'EDA execution failed'));
    } else {
      pending.resolve(msg.result ?? msg.data);
    }
    return;
  }

  if (msg.type === 'error') {
    const resultId = msg.id || msg.requestId;
    const pending = state.pending.get(resultId);
    if (!pending) return;
    state.pending.delete(resultId);
    remember({ event: 'eda-result', id: resultId, ok: false });
    pending.reject(new Error(msg.error || 'EDA execution failed'));
  }
}

function handleAgentMessage(socket, text) {
  const msg = JSON.parse(text);
  if (msg.type === 'execute') {
    executeInEda({ code: msg.code, windowId: msg.windowId, timeoutMs: msg.timeoutMs })
      .then(result => sendWs(socket, { type: 'result', id: msg.id, ok: true, result }))
      .catch(error => sendWs(socket, { type: 'result', id: msg.id, ok: false, error: error.message || String(error) }));
  }
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url, `http://${HOST}:${state.actualPort || PORT_START}`);
  debugLog('upgrade', {
    pathname: url.pathname,
    headers: {
      origin: req.headers.origin,
      host: req.headers.host,
      upgrade: req.headers.upgrade,
      connection: req.headers.connection,
      secWebSocketVersion: req.headers['sec-websocket-version'],
      secWebSocketProtocol: req.headers['sec-websocket-protocol']
    }
  });
  if (!checkToken(req, url)) {
    debugLog('upgrade-reject', { pathname: url.pathname, reason: 'bad-token' });
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.pathname !== '/eda' && url.pathname !== '/agent') {
    debugLog('upgrade-reject', { pathname: url.pathname, reason: 'bad-path' });
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    debugLog('upgrade-reject', { pathname: url.pathname, reason: 'missing-key' });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    '\r\n'
  ].join('\r\n'));

  if (url.pathname === '/agent') {
    state.agentClients.add(socket);
    remember({ event: 'agent-connect' });
  } else if (url.pathname === '/eda') {
    setTimeout(() => {
      debugLog('eda-handshake-send');
      sendWs(socket, {
        type: 'handshake',
        service: 'easyeda-bridge',
        bridge: 'easyeda-bridge',
        version: '0.2.0-codex',
        timestamp: Date.now()
      });
    }, 50);
  }

  socket.on('data', chunk => {
    try {
      parseWsFramesSafe(socket, chunk, text => {
        if (url.pathname === '/eda') handleEdaMessage(socket, text);
        if (url.pathname === '/agent') handleAgentMessage(socket, text);
      });
    } catch (error) {
      sendWs(socket, { type: 'error', error: error.message || String(error) });
    }
  });

  socket.on('close', () => {
    debugLog('socket-close', { pathname: url.pathname, edaId: socket._edaId || null });
    if (url.pathname === '/agent') state.agentClients.delete(socket);
    if (socket._edaId) {
      state.edaClients.delete(socket._edaId);
      if (state.selectedWindowId === socket._edaId) {
        state.selectedWindowId = state.edaClients.keys().next().value || null;
      }
      remember({ event: 'eda-disconnect', windowId: socket._edaId });
    }
  });

  socket.on('error', error => {
    debugLog('socket-error', { pathname: url.pathname, edaId: socket._edaId || null, error: error.message || String(error) });
  });
}

function sendRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcResult(id, value) {
  sendRpc({ jsonrpc: '2.0', id, result: value });
}

function rpcError(id, code, message) {
  sendRpc({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolText(content) {
  return { content: [{ type: 'text', text: content }] };
}

const tools = [
  {
    name: 'eda_status',
    description: 'Check Bridge/Gateway health and connected JLC EDA windows.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'eda_windows',
    description: 'List EDA windows connected through /eda.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'eda_select_window',
    description: 'Select which connected EDA window subsequent commands should target.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'string' } }
    }
  },
  {
    name: 'eda_execute',
    description: 'Execute JavaScript in the selected JLC EDA window. Code runs where window.eda/globalThis.eda exists.',
    inputSchema: {
      type: 'object',
      required: ['code'],
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        windowId: { type: 'string' },
        timeoutMs: { type: 'number' }
      }
    }
  },
  {
    name: 'eda_api_overview',
    description: 'Inspect top-level EDA API keys from window.eda/window.api in the selected EDA window.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  }
];

async function callTool(name, args = {}) {
  if (state.proxyBaseUrl) {
    if (name === 'eda_status') {
      return toolText(compact(await proxyRequest('GET', '/health')));
    }

    if (name === 'eda_windows') {
      return toolText(compact(await proxyRequest('GET', '/eda-windows')));
    }

    if (name === 'eda_select_window') {
      await proxyRequest('POST', '/eda-windows/select', { id: args.id });
      return toolText(`Selected EDA window: ${args.id}`);
    }

    if (name === 'eda_execute') {
      const value = await proxyRequest('POST', '/execute', {
        code: args.code,
        windowId: args.windowId,
        timeoutMs: args.timeoutMs
      });
      return toolText(compact(value.result ?? value));
    }

    if (name === 'eda_api_overview') {
      const value = await proxyRequest('POST', '/execute', {
        timeoutMs: 30_000,
        code: `
const api = globalThis.eda || globalThis.api;
if (!api) return { ok: false, hasEda: false, error: 'window.eda/window.api not found' };
const overview = {};
for (const key of Object.keys(api).sort()) {
  const item = api[key];
  overview[key] = {
    type: typeof item,
    keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 80) : undefined
  };
}
return { ok: true, hasEda: Boolean(globalThis.eda), hasApi: Boolean(globalThis.api), keys: Object.keys(api).sort(), overview };
`
      });
      return toolText(compact(value.result ?? value, 12000));
    }
  }

  if (name === 'eda_status') {
    return toolText(compact(statusPayload()));
  }

  if (name === 'eda_windows') {
    return toolText(compact({
      ok: true,
      selectedWindowId: state.selectedWindowId,
      windows: [...state.edaClients.values()].map(clientSummary)
    }));
  }

  if (name === 'eda_select_window') {
    if (!state.edaClients.has(args.id)) {
      return toolText(`EDA window not found: ${args.id}`);
    }
    state.selectedWindowId = args.id;
    return toolText(`Selected EDA window: ${args.id}`);
  }

  if (name === 'eda_execute') {
    const value = await executeInEda({
      code: args.code,
      windowId: args.windowId,
      timeoutMs: args.timeoutMs
    });
    return toolText(compact(value));
  }

  if (name === 'eda_api_overview') {
    const value = await executeInEda({
      timeoutMs: 30_000,
      code: `
const api = globalThis.eda || globalThis.api;
if (!api) return { ok: false, hasEda: false, error: 'window.eda/window.api not found' };
const overview = {};
for (const key of Object.keys(api).sort()) {
  const item = api[key];
  overview[key] = {
    type: typeof item,
    keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 80) : undefined
  };
}
return { ok: true, hasEda: Boolean(globalThis.eda), hasApi: Boolean(globalThis.api), keys: Object.keys(api).sort(), overview };
`
    });
    return toolText(compact(value, 12000));
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRpc(message) {
  const { id, method, params } = message;
  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-eda-bridge', version: '0.2.0' }
      });
    }
    if (method === 'tools/list') return rpcResult(id, { tools });
    if (method === 'tools/call') return rpcResult(id, await callTool(params?.name, params?.arguments || {}));
    if (method === 'ping') return rpcResult(id, {});
    if (id !== undefined) return rpcResult(id, {});
  } catch (error) {
    rpcError(id, -32000, error.message || String(error));
  }
}

function startMcp() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleRpc(JSON.parse(line));
      } catch (error) {
        rpcError(null, -32700, error.message || String(error));
      }
    }
  });
}

function listenOnAvailablePort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function startHttpBridge() {
  if (!FORCE_SERVER) {
    const existing = await findExistingBridge();
    if (existing) {
      state.actualPort = existing.port;
      state.proxyBaseUrl = existing.baseUrl;
      console.error(`[codex-eda-bridge] Attached to existing Bridge: ${existing.baseUrl}`);
      return;
    }
  }

  let lastError;
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    const server = http.createServer(handleHttp);
    server.on('upgrade', handleUpgrade);
    try {
      await listenOnAvailablePort(server, port);
      state.actualPort = port;
      console.error(`[codex-eda-bridge] Bridge: http://${HOST}:${port}`);
      console.error(`[codex-eda-bridge] EDA WS: ws://${HOST}:${port}/eda`);
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE') break;
    }
  }
  throw lastError || new Error(`No available port in ${PORT_START}-${PORT_END}`);
}

if (process.argv.includes('--smoke')) {
  console.log(JSON.stringify({
    ok: true,
    node: process.version,
    host: HOST,
    portRange: `${PORT_START}-${PORT_END}`,
    tokenRequired: Boolean(TOKEN)
  }, null, 2));
  process.exit(0);
}

await startHttpBridge();
startMcp();
