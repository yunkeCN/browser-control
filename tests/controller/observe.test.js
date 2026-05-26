'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { observeStart, observeDiff } = loadSourceModule('src/controller/commands/observe.ts');

// ─── 测试用例 ────────────────────────────────────────────────────

test('observe_start 成功: 返回 LLM-friendly 格式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'observe_start',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 250,
      data: {
        baselineId: 'obs_abc123',
        tabId: 108,
        url: 'https://example.com',
        summary: '观察基线已建立: obs_abc123',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await observeStart({ mode: 'viewport_text' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /观察基线已建立/);
  assert.match(result.summary, /obs_abc123/);

  assert.ok(result.data);
  assert.equal(result.data.baselineId, 'obs_abc123');
  assert.equal(result.data.tabId, 108);
  assert.equal(result.data.url, 'https://example.com');

  // 验证传递给 daemon 的参数
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'observe_start');
  assert.equal(fake.requests[0].args.mode, 'viewport_text');
});

test('observe_diff 成功: 有变化', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'observe_diff',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 300,
      data: {
        baselineId: 'obs_abc123',
        hasChanges: true,
        addedText: ['新按钮: "提交"', '新增段落: "操作成功"'],
        removedText: ['旧按钮: "取消"'],
        urlChanged: false,
        summary: '观察 diff: 检测到 3 处变化（新增 2 处，移除 1 处）',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await observeDiff(
    { baselineId: 'obs_abc123', includeNetwork: false },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /3 处变化/);
  assert.match(result.summary, /新增 2 处/);
  assert.match(result.summary, /移除 1 处/);

  assert.ok(result.data);
  assert.equal(result.data.baselineId, 'obs_abc123');
  assert.equal(result.data.hasChanges, true);
  assert.equal(result.data.addedText.length, 2);
  assert.equal(result.data.removedText.length, 1);
  assert.equal(result.data.urlChanged, false);

  // 验证传递给 daemon 的参数
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'observe_diff');
  assert.equal(fake.requests[0].args.baselineId, 'obs_abc123');
  assert.equal(fake.requests[0].args.includeNetwork, false);
});

test('observe_diff 成功: 无变化', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: true,
      command: 'observe_diff',
      data: {
        baselineId: 'obs_nochange',
        hasChanges: false,
        summary: '观察 diff: 未检测到变化',
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await observeDiff({ baselineId: 'obs_nochange' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /未检测到变化/);

  assert.ok(result.data);
  assert.equal(result.data.baselineId, 'obs_nochange');
  assert.equal(result.data.hasChanges, false);
  assert.equal(result.data.addedText, undefined);
  assert.equal(result.data.removedText, undefined);
});

test('observe_start 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'observe_start',
      session: 'test',
      error: {
        code: 'BACKEND_UNAVAILABLE',
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

  const result = await observeStart({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /no active tab/i);
  assert.ok(Array.isArray(result.nextSteps));
});

test('observe_diff 失败: 缺少 baselineId', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await observeDiff({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /baselineId/);
  assert.equal(result.data, undefined);
  assert.ok(Array.isArray(result.nextSteps));
});
