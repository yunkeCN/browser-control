'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { press } = loadSourceModule('src/controller/commands/press.ts');

// ─── 测试用例 ────────────────────────────────────────────────────

test('press 成功: 基本按键', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'press',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 50,
      data: {
        key: 'Enter',
        pressed: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await press({ key: 'Enter' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /按键/);
  assert.match(result.summary, /Enter/);

  assert.equal(result.pressed, true);

  // 验证 daemon 请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'press');
  assert.equal(fake.requests[0].args.key, 'Enter');
});

test('press 成功: 带修饰键', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'press',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 60,
      data: {
        key: 'a',
        pressed: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await press(
    { key: 'a', modifiers: ['Control'], target: '@e5abc_1' },
    client,
  );

  assert.equal(result.ok, true);
  assert.equal(result.pressed, true);
  assert.match(result.summary, /a/);

  // 验证修饰键参数传递
  assert.equal(fake.requests[0].args.key, 'a');
  assert.deepEqual(fake.requests[0].args.modifiers, ['Control']);
  assert.equal(fake.requests[0].args.target, '@e5abc_1');
});

test('press 失败: 缺少 key', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await press({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /key/);
  assert.ok(Array.isArray(result.nextSteps));
});

test('press 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'press',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'No element currently focused for keyboard input',
        retryable: true,
        details: {
          nextSteps: [
            'Click on an element first to give it focus.',
            'Specify a target element with @e reference.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await press({ key: 'Enter' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /focused/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});
