'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { clickProbe } = loadSourceModule('src/controller/commands/click-probe.ts');

// ─── 测试用例 ────────────────────────────────────────────────────

test('click_probe 成功: 捕获到网络请求', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click_probe',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 350,
      data: {
        clicked: true,
        networkRequests: [
          {
            url: 'https://api.example.com/users',
            method: 'POST',
            statusCode: 201,
          },
          {
            url: 'https://api.example.com/data',
            method: 'GET',
            statusCode: 200,
          },
          {
            url: 'https://cdn.example.com/analytics.gif',
            method: 'GET',
            statusCode: 204,
          },
        ],
        requestCount: 3,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await clickProbe({ target: '@e91_1' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /点击/);
  assert.match(result.summary, /捕获到.*3.*网络请求/);

  assert.ok(result.data);
  assert.equal(result.data.clicked, true);
  assert.equal(result.data.requestCount, 3);
  assert.ok(result.data.networkRequests);
  assert.equal(result.data.networkRequests.length, 3);
  assert.equal(result.data.networkRequests[0].url, 'https://api.example.com/users');
  assert.equal(result.data.networkRequests[0].method, 'POST');
  assert.equal(result.data.networkRequests[0].statusCode, 201);
  assert.equal(result.data.networkRequests[1].url, 'https://api.example.com/data');
  assert.equal(result.data.networkRequests[2].url, 'https://cdn.example.com/analytics.gif');

  // 验证 daemon 实际收到了正确的请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'click_probe');
  assert.equal(fake.requests[0].args.target, '@e91_1');
});

test('click_probe 成功: 带 filter 过滤网络请求', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click_probe',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 280,
      data: {
        clicked: true,
        networkRequests: [
          {
            url: 'https://api.example.com/users/42',
            method: 'GET',
            statusCode: 200,
          },
        ],
        requestCount: 1,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await clickProbe(
    { target: '@e91_1', filter: '/api/users' },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /点击/);
  assert.match(result.summary, /捕获到.*1.*网络请求/);

  assert.ok(result.data);
  assert.equal(result.data.clicked, true);
  assert.equal(result.data.requestCount, 1);
  assert.ok(result.data.networkRequests);
  assert.equal(result.data.networkRequests.length, 1);
  assert.equal(result.data.networkRequests[0].url, 'https://api.example.com/users/42');
  assert.equal(result.data.networkRequests[0].method, 'GET');
  assert.equal(result.data.networkRequests[0].statusCode, 200);

  // 验证 daemon 收到了 filter 参数
  assert.equal(fake.requests[0].args.target, '@e91_1');
  assert.equal(fake.requests[0].args.filter, '/api/users');
});

test('click_probe 成功: 未捕获到网络请求', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click_probe',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 150,
      data: {
        clicked: true,
        networkRequests: [],
        requestCount: 0,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await clickProbe(
    { target: 'css=.no-network-button' },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /点击/);
  assert.match(result.summary, /未捕获到/);

  assert.ok(result.data);
  assert.equal(result.data.clicked, true);
  assert.equal(result.data.requestCount, 0);
  assert.ok(result.data.networkRequests);
  assert.equal(result.data.networkRequests.length, 0);

  // 验证 CSS 选择器格式的 target 传递正确
  assert.equal(fake.requests[0].args.target, 'css=.no-network-button');
});

test('click_probe 失败: 缺少 target 参数', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await clickProbe({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /target|参数/);
  assert.equal(result.data, undefined);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});

test('click_probe 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'click_probe',
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

  const result = await clickProbe({ target: '@e999_1' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});
