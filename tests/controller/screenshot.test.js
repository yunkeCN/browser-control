'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { screenshot } = loadSourceModule('src/controller/commands/screenshot.ts');

test('screenshot 成功: PNG 格式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'screenshot',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 350,
      data: {
        filePath: '/tmp/screenshots/2026-05-26_14-30-00.png',
        format: 'png',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await screenshot({ format: 'png' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /截图已保存到/);
  assert.match(result.summary, /\.png/);

  assert.ok(result.data);
  assert.equal(result.data.filePath, '/tmp/screenshots/2026-05-26_14-30-00.png');
  assert.equal(result.data.format, 'png');
  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'screenshot');
});

test('screenshot 成功: JPEG 格式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'screenshot',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 400,
      data: {
        filePath: '/tmp/screenshots/2026-05-26_14-31-00.jpg',
        format: 'jpeg',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await screenshot(
    { format: 'jpeg', quality: 85, fileName: 'custom-shot' },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /\.jpg/);
  assert.equal(result.data.filePath, '/tmp/screenshots/2026-05-26_14-31-00.jpg');
  assert.equal(result.data.format, 'jpeg');

  assert.equal(fake.requests[0].args.format, 'jpeg');
  assert.equal(fake.requests[0].args.quality, 85);
  assert.equal(fake.requests[0].args.fileName, 'custom-shot');
});

test('screenshot 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'screenshot',
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

  const result = await screenshot({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /no active tab/i);
  assert.ok(Array.isArray(result.nextSteps));
});
