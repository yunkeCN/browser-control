'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { getText } = loadSourceModule('src/controller/commands/get-text.ts');

test('get-text 成功: 获取完整文本', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'get_text',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 80,
      data: {
        text: '这是页面文本内容。包含一些可见文本。',
        length: 18,
        truncated: false,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await getText({}, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /获取到/);
  assert.match(result.summary, /18/);
  assert.match(result.summary, /完整文本/);

  assert.ok(result.data);
  assert.equal(result.data.text, '这是页面文本内容。包含一些可见文本。');
  assert.equal(result.data.length, 18);
  assert.equal(result.data.truncated, false);
  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'get_text');
});

test('get-text 成功: 视口范围', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'get_text',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 60,
      data: {
        text: '视口内可见文本',
        length: 8,
        truncated: false,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await getText({ scope: 'viewport' }, client);

  assert.equal(result.ok, true);
  assert.equal(result.data.text, '视口内可见文本');
  assert.equal(result.data.length, 8);
  assert.equal(result.data.truncated, false);

  assert.equal(fake.requests[0].args.scope, 'viewport');
});

test('get-text 成功: 文本被截断（truncated=true）', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'get_text',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 90,
      data: {
        text: '这是一段被截断的文本...',
        length: 1200,
        truncated: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await getText({ maxChars: 1200 }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /1200\+/);
  assert.match(result.summary, /截断/);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.length, 1200);
});

test('get-text 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'get_text',
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

  const result = await getText({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /no active tab/i);
  assert.ok(Array.isArray(result.nextSteps));
});
