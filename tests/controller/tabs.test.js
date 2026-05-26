'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { listTabs, findTab, closeTab } = loadSourceModule(
  'src/controller/commands/tabs.ts',
);

/**
 * tabs 集成测试
 *
 * 使用真实 HTTP fake daemon 测试 listTabs / findTab / closeTab 命令的完整执行流程：
 * validate -> execute daemon -> handle errors -> toResult -> CommandResult
 */

// ─── listTabs ──────────────────────────────────────────────────────

test('list_tabs 成功: 返回多标签页列表', async (t) => {
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

  const result = await listTabs({}, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /标签页列表/);
  assert.match(result.summary, /3.*标签/);
  assert.match(result.summary, /1.*活跃/);

  assert.ok(result.data);
  assert.equal(result.data.count, 3);
  assert.equal(result.data.tabs.length, 3);
  assert.equal(result.data.tabs[0].tabId, 1);
  assert.equal(result.data.tabs[0].title, 'Google');
  assert.equal(result.data.tabs[0].url, 'https://google.com');
  assert.equal(result.data.tabs[0].active, true);
  assert.equal(result.data.tabs[1].active, false);

  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'list_tabs');
});

test('list_tabs 成功: 无标签页', async (t) => {
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

  const result = await listTabs({}, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /0.*标签/);
  assert.match(result.summary, /0.*活跃/);

  assert.ok(result.data);
  assert.equal(result.data.count, 0);
  assert.equal(result.data.tabs.length, 0);
});

// ─── findTab ───────────────────────────────────────────────────────

test('find_tab 成功: 按 URL 查找', async (t) => {
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

  const result = await findTab({ urlIncludes: 'google.com' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /找到标签页/);
  assert.match(result.summary, /Google/);
  assert.match(result.summary, /tabId=42/);

  assert.ok(result.data);
  assert.equal(result.data.found, true);
  assert.equal(result.data.tabId, 42);
  assert.equal(result.data.title, 'Google');
  assert.equal(result.data.url, 'https://google.com');

  assert.equal(fake.requests[0].command, 'find_tab');
  assert.equal(fake.requests[0].args.urlIncludes, 'google.com');
});

test('find_tab 成功: 按标题查找', async (t) => {
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

  const result = await findTab({ titleIncludes: 'Claude' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /找到标签页/);
  assert.match(result.summary, /Claude/);
  assert.match(result.summary, /tabId=7/);

  assert.ok(result.data);
  assert.equal(result.data.found, true);
  assert.equal(result.data.tabId, 7);

  assert.equal(fake.requests[0].args.titleIncludes, 'Claude');
});

test('find_tab 失败: 未找到匹配的标签页', async (t) => {
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

  const result = await findTab({ urlIncludes: 'nonexistent.example' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /未找到/);
  assert.equal(result.data, undefined);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});

// ─── closeTab ──────────────────────────────────────────────────────

test('close_tab 成功: 关闭指定标签页', async (t) => {
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

  const result = await closeTab({ tabId: 108 }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /已关闭/);
  assert.match(result.summary, /tabId=108/);

  assert.ok(result.data);
  assert.equal(result.data.closed, true);
  assert.equal(result.data.tabId, 108);

  assert.equal(fake.requests[0].command, 'close_tab');
  assert.equal(fake.requests[0].args.tabId, 108);
});

test('close_tab 失败: daemon 返回错误', async (t) => {
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

  const result = await closeTab({ tabId: 999 }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});
