'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

// 加载 TypeScript 源文件
const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { navigate } = loadSourceModule('src/controller/commands/navigate.ts');

/**
 * navigate 集成测试
 *
 * 使用真实 HTTP fake daemon 测试 navigate 命令的完整执行流程：
 * validate → execute daemon → handle errors → toResult → CommandResult
 */

test('navigate 成功: 返回 LLM-friendly 格式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'navigate',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: '2026-05-25T00:00:00.001Z',
      durationMs: 1,
      data: {
        url: 'https://example.com',
        title: 'Example Domain',
        tabId: 42,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await navigate({ url: 'https://example.com' }, client);

  // 核心断言: ok + summary + data
  assert.equal(result.ok, true, 'ok 应为 true');
  assert.match(result.summary, /导航/, 'summary 应包含「导航」');
  assert.match(result.summary, /example/, 'summary 应包含目标 URL');

  // data 验证
  assert.ok(result.data, '成功时应有 data');
  assert.equal(result.data.finalUrl, 'https://example.com');
  assert.equal(result.data.title, 'Example Domain');
  assert.equal(result.data.tabId, 42);

  // 成功无 nextSteps
  assert.equal(result.nextSteps, undefined);

  // 验证 daemon 实际收到了正确的请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'navigate');
  assert.deepEqual(fake.requests[0].args, { url: 'https://example.com' });
});

test('navigate 成功: 新标签页模式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'navigate',
      backend: 'extension',
      session: envelope.session,
      tab: 43,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 500,
      data: {
        url: 'https://google.com',
        title: 'Google',
        tabId: 43,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await navigate(
    { url: 'https://google.com', newTab: true },
    client,
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.finalUrl, 'https://google.com');
  assert.equal(result.data.title, 'Google');
  assert.equal(result.data.tabId, 43);

  // 验证传递给 daemon 的参数
  assert.equal(fake.requests[0].args.newTab, true);
});

test('navigate 失败: 缺少 url 参数', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await navigate({}, client);

  assert.equal(result.ok, false, '无 url 时应返回错误');
  assert.match(result.summary, /url|参数/, 'summary 应提示缺少参数');
  assert.equal(result.data, undefined, '失败时不应有 data');
  assert.ok(
    Array.isArray(result.nextSteps),
    '验证失败时应提供 nextSteps',
  );
});

test('navigate 失败: 空 url 参数', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await navigate({ url: '' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /url|参数/);
});

test('navigate 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'navigate',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'Navigation timeout: page did not load within 30000ms',
        retryable: true,
        details: {
          nextSteps: [
            'Increase timeoutMs and retry.',
            'Check if the URL is accessible from this network.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await navigate({ url: 'https://slow-site.com' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /timeout/i);
  assert.ok(Array.isArray(result.nextSteps), '错误时应提供 nextSteps');
  assert.ok(
    result.nextSteps.length > 0,
    'nextSteps 不应为空',
  );
});

test('navigate 失败: daemon 无响应', async (t) => {
  // 使用一个不可能连接的端口
  const client = new DaemonClient({ port: 18999, host: '127.0.0.1' });

  const result = await navigate({ url: 'https://example.com' }, client);

  assert.equal(result.ok, false);
  assert.match(
    result.summary,
    /daemon|connect|refused/i,
    'daemon 无响应时应有明确提示',
  );
  assert.ok(Array.isArray(result.nextSteps));
});

test('navigate 成功: 超时参数传递正确', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'navigate',
      backend: 'extension',
      session: envelope.session,
      tab: 44,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 10000,
      data: {
        url: 'https://example.com',
        title: 'Example',
        tabId: 44,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await navigate(
    { url: 'https://example.com', timeoutMs: 60000 },
    client,
  );

  assert.equal(result.ok, true);
  assert.equal(fake.requests[0].timeoutMs, 60000);
});
