'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { tabs } = loadSourceModule('src/controller/commands/tabs.ts');

/**
 * tabs 集成测试
 *
 * 统一的 tabs 命令通过 action 参数区分操作: list / switch / close
 * execute() 返回 { ...response.data, _action: action }
 * toResult(raw) 根据 raw._action 路由，从 raw.data 中读取具体字段
 * 成功时 CommandResult 是扁平的（各 action 格式不同）
 */

// ─── action: list ─────────────────────────────────────────────────

test('tabs list 成功: 返回多标签页列表', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'list_tabs',
      backend: 'extension',
      session: envelope.session,
      tab: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 30,
      data: {
        tabs: [
          { tabId: 1, title: 'Google', url: 'https://google.com', active: true },
          { tabId: 2, title: 'GitHub', url: 'https://github.com', active: false },
          { tabId: 3, title: 'Claude', url: 'https://claude.ai', active: false },
        ],
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await tabs({ action: 'list', session: 'mcp-active-session' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /标签页列表/);
  assert.match(result.summary, /3.*标签/);
  assert.match(result.summary, /1.*活跃/);

  // 扁平字段验证
  assert.equal(result.count, 3);
  assert.equal(result.tabs.length, 3);
  assert.equal(result.tabs[0].tabId, 1);
  assert.equal(result.tabs[0].title, 'Google');
  assert.equal(result.tabs[0].url, 'https://google.com');
  assert.equal(result.tabs[0].active, true);
  assert.equal(result.tabs[1].active, false);

  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'list_tabs');
  assert.equal(fake.requests[0].session, 'mcp-active-session');
});

test('tabs list 成功: 无标签页', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'list_tabs',
      backend: 'extension',
      session: envelope.session,
      tab: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 10,
      data: {
        tabs: [],
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await tabs({ action: 'list' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /0.*标签/);
  assert.match(result.summary, /0.*活跃/);

  assert.equal(result.count, 0);
  assert.equal(result.tabs.length, 0);
});

// ─── action: switch ───────────────────────────────────────────────

test('tabs switch 成功: 按 URL 查找', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'find_tab',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 20,
      data: {
        tabId: 42,
        title: 'Google',
        url: 'https://google.com',
        found: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await tabs({ action: 'switch', urlIncludes: 'google.com', session: 'mcp-active-session' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /已切换到标签页/);
  assert.match(result.summary, /Google/);
  assert.match(result.summary, /tabId=42/);

  // 扁平字段验证
  assert.equal(result.found, true);
  assert.equal(result.tabId, 42);
  assert.equal(result.title, 'Google');
  assert.equal(result.url, 'https://google.com');

  assert.equal(fake.requests[0].command, 'find_tab');
  assert.equal(fake.requests[0].session, 'mcp-active-session');
  assert.equal(fake.requests[0].args.urlIncludes, 'google.com');
});

test('tabs switch 成功: 按标题查找', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'find_tab',
      backend: 'extension',
      session: envelope.session,
      tab: 7,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 15,
      data: {
        tabId: 7,
        title: 'Claude',
        url: 'https://claude.ai',
        found: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await tabs({ action: 'switch', titleIncludes: 'Claude' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /已切换到标签页/);
  assert.match(result.summary, /Claude/);
  assert.match(result.summary, /tabId=7/);

  assert.equal(result.found, true);
  assert.equal(result.tabId, 7);

  assert.equal(fake.requests[0].args.titleIncludes, 'Claude');
});

test('tabs switch 失败: 未找到匹配的标签页', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'find_tab',
      backend: 'extension',
      session: envelope.session,
      tab: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 10,
      data: {
        found: false,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await tabs({ action: 'switch', urlIncludes: 'nonexistent.example' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /未找到/);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});

// ─── action: close ────────────────────────────────────────────────

test('tabs close 成功: 关闭指定标签页', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'close_tab',
      backend: 'extension',
      session: envelope.session,
      tab: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 25,
      data: {
        closed: true,
        tabId: 108,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await tabs({ action: 'close', tabId: 108 }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /已关闭/);
  assert.match(result.summary, /tabId=108/);

  // 扁平字段验证
  assert.equal(result.closed, true);
  assert.equal(result.tabId, 108);

  assert.equal(fake.requests[0].command, 'close_tab');
  assert.equal(fake.requests[0].args.tabId, 108);
});

test('tabs close 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'close_tab',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'Tab not found: tabId=999',
        retryable: false,
        details: {
          nextSteps: [
            'Use list_tabs to find the correct tab ID.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await tabs({ action: 'close', tabId: 999 }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});
