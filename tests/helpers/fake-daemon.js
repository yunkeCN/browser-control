'use strict';

/**
 * Fake Daemon — 用于 Controller 集成测试
 *
 * 创建一个真实的 HTTP server 模拟 daemon 行为，
 * 使得 Controller 的集成测试可以连接真实 HTTP 端口，
 * 而不需要启动真实的 daemon 和 Chrome 扩展。
 */

const http = require('node:http');
const rootPkg = require('../../package.json');
const {
  PROTOCOL_VERSION,
  RUNTIME_SCHEMA_VERSION,
  DAEMON_CAPABILITIES,
} = require('../../skills/browser-control/scripts/protocol');

/**
 * 创建一个 fake daemon HTTP 服务器
 *
 * @param {object} options
 * @param {object} [options.status] - GET /status 和 GET /health 的返回体
 * @param {(envelope: object) => object} [options.onCommand] - POST /command 的自定义处理函数
 * @param {object} [options.defaultCommandResponse] - POST /command 的默认返回体
 * @returns {{ server: import('http').Server, requests: object[], listen: () => Promise<void>, close: () => Promise<void>, port: () => number }}
 */
function createFakeDaemon(options = {}) {
  const requests = [];

  const defaultStatus = {
    running: true,
    status: 'ok',
    version: rootPkg.version,
    extension_connected: false,
    runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: DAEMON_CAPABILITIES,
    runtime: {
      daemon: {
        layer: 'daemon',
        version: rootPkg.version,
        protocolVersion: PROTOCOL_VERSION,
        runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
        capabilities: DAEMON_CAPABILITIES,
      },
    },
  };

  const defaultCommandResponse = {
    id: 'fake-id',
    ok: true,
    command: 'unknown',
    backend: 'extension',
    session: 'test-session',
    tab: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    data: { echoedArgs: {} },
    artifacts: [],
    error: null,
    diagnostics: null,
  };

  const server = http.createServer((req, res) => {
    // ── Health / Status ────────────────────────────────────────
    if (
      req.method === 'GET' &&
      (req.url === '/status' || req.url === '/health')
    ) {
      const body = options.status || defaultStatus;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    // ── Command ────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/command') {
      let text = '';
      req.on('data', (chunk) => {
        text += chunk;
      });
      req.on('end', () => {
        const envelope = JSON.parse(text);
        requests.push(envelope);

        let responseBody;
        if (options.onCommand) {
          responseBody = options.onCommand(envelope);
        } else {
          responseBody = {
            ...defaultCommandResponse,
            command: envelope.command,
            id: envelope.id,
            session: envelope.session,
            data: { echoedArgs: envelope.args },
          };
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }

    // ── 404 ────────────────────────────────────────────────────
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  return {
    server,
    /** 所有收到的请求记录 */
    requests,
    /** 启动服务器（随机端口） */
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    /** 关闭服务器 */
    close: () => new Promise((resolve) => server.close(resolve)),
    /** 获取实际端口号 */
    port: () => server.address().port,
  };
}

module.exports = { createFakeDaemon };
