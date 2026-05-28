'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { fill } = loadSourceModule('src/controller/commands/fill.ts');

// ─── 测试用例 ────────────────────────────────────────────────────

test('fill 成功: 基本填写', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'fill',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      data: {
        target: '@e1abc_1',
        value: 'hello world',
        filled: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await fill({ target: '@e1abc_1', value: 'hello world' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /填写/);
  assert.match(result.summary, /@e1abc_1/);
  assert.match(result.summary, /hello world/);

  assert.equal(result.filled, true);

  // 验证 daemon 请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'fill');
  assert.equal(fake.requests[0].args.target, '@e1abc_1');
  assert.equal(fake.requests[0].args.value, 'hello world');
});

test('fill 成功: 清除后填写', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'fill',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 150,
      data: {
        target: 'css=#search-input',
        value: 'new text',
        filled: true,
        changeSummary: '已清除原有内容并填入新文本',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await fill(
    { target: 'css=#search-input', value: 'new text', clear: true },
    client,
  );

  assert.equal(result.ok, true);
  assert.equal(result.filled, true);
  assert.equal(result.changeSummary, '已清除原有内容并填入新文本');
  assert.match(result.summary, /new text/);

  // 验证清除参数传递
  assert.equal(fake.requests[0].args.clear, true);
});

test('fill 失败: 缺少 target', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await fill({ value: 'hello' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /target/);
  assert.ok(Array.isArray(result.nextSteps));
});

test('fill 失败: 缺少 value', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await fill({ target: '@e1abc_1' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /value/);
});

test('fill 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'fill',
      session: 'test',
      error: {
        code: 'ELEMENT_NOT_FOUND',
        message: 'Element @e1abc_1 not found in current page',
        retryable: true,
        details: {
          nextSteps: [
            'Run snapshot to refresh the list of available elements.',
            'Verify the page has not changed since the snapshot was taken.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await fill({ target: '@e1abc_1', value: 'hello' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});
