'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { click } = loadSourceModule('src/controller/commands/click.ts');

// ─── 基础点击（target 模式）────────────────────────────────────

test('click 成功: 基础 target 模式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 250,
      data: {
        clicked: true,
        newTabOpened: false,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({ target: '@e91_1', session: 'mcp-active-session' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /已点击元素/);
  assert.equal(result.clicked, true);
  assert.equal(result.newTabOpened, false);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'click');
  assert.equal(fake.requests[0].session, 'mcp-active-session');
  assert.equal(fake.requests[0].args.target, '@e91_1');
});

test('click 成功: CSS 选择器 target', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      data: {
        clicked: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({ target: 'css=.search-button' }, client);

  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(fake.requests[0].args.target, 'css=.search-button');
});

test('click 成功: 带 changes 和 baselineId', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 300,
      data: {
        clicked: true,
        settle: { settled: true, postClickDelayMs: 500 },
        changes: {
          baselineId: 'click_xxx',
          warnings: ['no visible text changed'],
        },
        network: {
          requests: [{ method: 'GET', url: '/api/filter' }],
          count: 1,
        },
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await click({ target: '@e75_1' }, client);

  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(result.baselineId, 'click_xxx');
  assert.deepEqual(result.settle, { settled: true, postClickDelayMs: 500 });
  assert.deepEqual(result.changes, { baselineId: 'click_xxx', warnings: ['no visible text changed'] });
  assert.deepEqual(result.network, { requests: [{ method: 'GET', url: '/api/filter' }], count: 1 });
  assert.deepEqual(result.warnings, ['no visible text changed']);
  assert.match(result.summary, /观察基线/);
});

// ─── 请求拦截和观察模式 ─────────────────────────────────────────

test('click 成功: 请求拦截和观察模式捕获网络请求', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => {
      return {
        id: envelope.id,
        ok: true,
        command: envelope.command,
        backend: 'extension',
        session: envelope.session,
        tab: 108,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 400,
        data: {
          clicked: true,
          probe: {
            interceptedCount: 1,
            requests: [
              { url: '/api/submit', method: 'POST', statusCode: 200 },
            ],
            warnings: [],
          },
        },
        artifacts: [],
        error: null,
        diagnostics: null,
      };
    },
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({
    target: '@e91_1',
    interceptRequests: { filter: '/api/', includeBody: true },
    session: 'mcp-active-session',
  }, client);

  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.match(result.summary, /拦截 1 个接口请求/);
  assert.equal(result.probe.interceptedCount, 1);
  assert.equal(result.probe.requests[0].url, '/api/submit');
  assert.equal(result.probe.requests[0].method, 'POST');
  assert.equal(fake.requests[0].command, 'click');
  assert.equal(fake.requests[0].session, 'mcp-active-session');
  assert.deepEqual(fake.requests[0].args.interceptRequests, { filter: '/api/', includeBody: true });
});

test('click 成功: 请求拦截和观察模式无网络请求', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: envelope.command,
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 200,
      data: {
        clicked: true,
        probe: {
          interceptedCount: 0,
          requests: [],
          warnings: [],
        },
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({
    target: '@e91_1',
    interceptRequests: { filter: '/api/' },
  }, client);

  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(result.probe.interceptedCount, 0);
  assert.equal(fake.requests[0].command, 'click');
  assert.deepEqual(fake.requests[0].args.interceptRequests, { filter: '/api/' });
});

// ─── text 模式 ──────────────────────────────────────────────────

test('click 成功: text 模式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      data: {
        clicked: true,
        textClick: {
          method: 'ref',
          ref: '@eabc_1',
          text: 'Submit',
          role: 'button',
          boxCenterX: 235,
          boxCenterY: 310,
          distance: 38,
          candidateCount: 1,
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({ text: 'Submit', x: 200, y: 300, session: 'mcp-active-session' }, client);

  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(result.method, 'ref');
  assert.equal(result.ref, '@eabc_1');
  assert.equal(result.matchedText, 'Submit');
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'click');
  assert.equal(fake.requests[0].session, 'mcp-active-session');
  assert.equal(fake.requests[0].args.text, 'Submit');
  assert.equal(fake.requests[0].args.x, 200);
  assert.equal(fake.requests[0].args.y, 300);
});

test('click 成功: text 模式无 ref 时保留坐标参数给 click', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      data: {
        clicked: true,
        textClick: {
          method: 'cdp',
          text: 'Submit',
          role: 'generic',
          boxCenterX: 220,
          boxCenterY: 300,
          distance: 20,
          candidateCount: 1,
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({ text: 'Submit', x: 200, y: 300, session: 'mcp-active-session' }, client);

  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(result.method, 'cdp');
  assert.equal(result.boxCenterX, 220);
  assert.equal(result.boxCenterY, 300);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'click');
  assert.equal(fake.requests[0].session, 'mcp-active-session');
  assert.equal(fake.requests[0].args.x, 200);
  assert.equal(fake.requests[0].args.y, 300);
});

// ─── 失败用例 ───────────────────────────────────────────────────

test('click 失败: 缺少 target 和 text', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await click({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /target|text|参数/);
  assert.ok(Array.isArray(result.nextSteps));
});

test('click 失败: 无效 target 格式', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await click({ target: 'just-some-text' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /target|参数|格式|@e|css/);
});

test('click 失败: text 模式缺少 x', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await click({ text: 'Submit', y: 300 }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /x/);
});

test('click 失败: target 和 text 互斥', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await click({ target: '@e1_1', text: 'Submit', x: 100, y: 200 }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /互斥/);
});

test('click 失败: daemon 返回错误（元素未找到）', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'click',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'Element not found: @e999_1',
        retryable: true,
        details: {
          nextSteps: [
            'Run snapshot to refresh the element references.',
            'Use a css= selector as fallback.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({ target: '@e999_1' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});
