'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { waitFor } = loadSourceModule('src/controller/commands/wait-for.ts');

/**
 * wait-for 集成测试
 *
 * execute() 返回 response.data（daemon 响应体整体）
 * toResult(raw) 从 raw.data 中读取 found / state / selector / text / expression
 * 成功时 CommandResult 是扁平的: { ok, summary, found, state }
 * found=false 时: { ok: false, summary: "等待超时: ..." }
 */

test('wait-for 成功: 等待文本出现', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'wait_for',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1200,
      data: {
        found: true,
        state: 'visible',
        text: 'Loading',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await waitFor(
    { text: 'Loading', state: 'visible' },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /等待成功/);
  assert.match(result.summary, /visible/);

  // 扁平字段验证
  assert.equal(result.found, true);
  assert.equal(result.state, 'visible');
  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'wait_for');
  assert.equal(fake.requests[0].args.text, 'Loading');
  assert.equal(fake.requests[0].args.state, 'visible');
});

test('wait-for 成功: 等待选择器', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'wait_for',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 800,
      data: {
        found: true,
        state: 'attached',
        selector: '#result-panel',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await waitFor(
    { selector: '#result-panel', state: 'attached', timeoutMs: 10000 },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /等待成功/);
  assert.match(result.summary, /attached/);
  assert.equal(result.found, true);
  assert.equal(result.state, 'attached');

  assert.equal(fake.requests[0].args.selector, '#result-panel');
  assert.equal(fake.requests[0].timeoutMs, 10000);
});

test('wait-for 失败: found=false 超时', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'wait_for',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 5000,
      data: {
        found: false,
        state: 'visible',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await waitFor(
    { text: 'NonExistentText', timeoutMs: 5000 },
    client,
  );

  assert.equal(result.ok, false);
  assert.match(result.summary, /等待超时/);
});

test('wait-for 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'wait_for',
      session: 'test',
      error: {
        code: 'TIMEOUT',
        message: 'Timeout: element did not become visible within 5000ms',
        retryable: true,
        details: {
          nextSteps: [
            'Increase timeoutMs and retry.',
            'Check if the page has loaded correctly.',
            'Verify the selector or text pattern.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await waitFor(
    { text: 'NonExistentText', timeoutMs: 5000 },
    client,
  );

  assert.equal(result.ok, false);
  assert.match(result.summary, /timeout/i);
  assert.ok(Array.isArray(result.nextSteps));
});

test('wait-for 失败: daemon 返回 BACKEND_ERROR', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'wait_for',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'No active tab in session',
        retryable: true,
        details: {
          nextSteps: [
            'Run navigate to open a tab, or find_tab with attach=true to reuse an existing tab.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await waitFor({ text: 'Hello' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /no active tab/i);
  assert.ok(Array.isArray(result.nextSteps));
});
