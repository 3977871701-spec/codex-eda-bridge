(function connectCodexEdaBridge() {
  const scriptUrl = document.currentScript && document.currentScript.src
    ? new URL(document.currentScript.src)
    : null;
  const bridge = scriptUrl ? `ws://${scriptUrl.host}/eda` : 'ws://127.0.0.1:49620/eda';
  const clientId = `eda-${Date.now().toString(36)}`;

  function serialize(value) {
    if (value === undefined) return null;
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return String(value);
    }
  }

  async function runUserCode(code) {
    const runner = new Function(`
      return (async () => {
        ${code}
      })();
    `);
    return await runner.call(window);
  }

  function connect() {
    const ws = new WebSocket(bridge);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'register',
        id: clientId,
        window: {
          id: clientId,
          title: document.title,
          href: location.href,
          userAgent: navigator.userAgent,
          apiKeys: Object.keys(window.eda || window.api || {}).sort()
        }
      }));
      console.log('[codex-eda-bridge] connected', bridge);
    });

    ws.addEventListener('message', async event => {
      const message = JSON.parse(event.data);
      if (message.type !== 'execute') return;
      try {
        const result = await runUserCode(message.code);
        ws.send(JSON.stringify({
          type: 'result',
          id: message.id,
          ok: true,
          result: serialize(result)
        }));
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'result',
          id: message.id,
          ok: false,
          error: error && error.stack ? error.stack : String(error)
        }));
      }
    });

    ws.addEventListener('close', () => {
      console.warn('[codex-eda-bridge] disconnected; reconnecting in 2s');
      setTimeout(connect, 2000);
    });

    ws.addEventListener('error', error => {
      console.warn('[codex-eda-bridge] websocket error', error);
    });
  }

  connect();
})();
