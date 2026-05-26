'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { evaluate } = loadSourceModule('src/controller/commands/evaluate.ts');

test('evaluate 成功: 返回字符串', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'evaluate',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 50,
      data: {
        result: 'Hello from the page!',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await evaluate(
    { code: 'document.title' },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /JS 执行完成/);
  assert.match(result.summary, /string/);

  assert.ok(result.data);
  assert.equal(result.data.result, 'Hello from the page!');
  assert.equal(result.data.type, 'string');
  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'evaluate');
  assert.equal(fake.requests[0].args.code, 'document.title');
});

test('evaluate 成功: 返回数字', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'evaluate',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 40,
      data: {
        result: 42,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await evaluate(
    { code: 'document.querySelectorAll("a").length' },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /number/);
  assert.equal(result.data.result, 42);
  assert.equal(result.data.type, 'number');
});

test('evaluate 失败: 缺少 code', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await evaluate({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /code/);
  assert.equal(result.data, undefined);
  assert.ok(Array.isArray(result.nextSteps));
});

test('evaluate 失败: code 为空', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await evaluate({ code: '' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /空/);
  assert.equal(result.data, undefined);
});

test('evaluate 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'evaluate',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'JavaScript execution failed: ReferenceError: foo is not defined',
        retryable: false,
        details: {
          nextSteps: [
            'Check the JavaScript code for syntax errors.',
            'Use simpler expressions to debug step by step.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await evaluate(
    { code: 'foo.bar()' },
    client,
  );

  assert.equal(result.ok, false);
  assert.match(result.summary, /ReferenceError/i);
  assert.ok(Array.isArray(result.nextSteps));
});
