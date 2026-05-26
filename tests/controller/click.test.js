'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { click } = loadSourceModule('src/controller/commands/click.ts');

/** 点击后快照的 YAML 树示例（与 Playwright MCP 格式一致） */
const POST_SNAPSHOT_YAML = [
  '- main [ref=@e59_1]:',
  '  - heading "Search Results" [level=2] [ref=@e63_1]',
  '  - link "Result 1" [ref=@e70_1] [cursor=pointer]',
  '  - link "Result 2" [ref=@e71_1] [cursor=pointer]',
  '  - button "Next Page" [ref=@e75_1] [cursor=pointer]',
].join('\n');

// ─── 测试用例 ────────────────────────────────────────────────────

test('click 成功: after=auto 模式（返回变化摘要）', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 250,
      data: {
        clicked: true,
        after: 'auto',
        settle: { settled: true, elapsedMs: 200 },
        changes: {
          baselineId: 'click_xxx',
          summary: 'Visible text added: "Search results".',
          textDiff: {
            addedText: ['Search results'],
            removedText: [],
            truncated: false,
          },
        },
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({ target: '@e91_1', after: 'auto' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /点击/);
  assert.match(result.summary, /Search results/);

  assert.ok(result.data);
  assert.equal(result.data.clicked, true);
  assert.equal(
    result.data.changeSummary,
    'Visible text added: "Search results".',
  );
  assert.equal(result.data.newTabOpened, false);
  assert.equal(result.data.postSnapshot, undefined);

  // 验证 daemon 实际收到了正确的请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'click');
  assert.equal(fake.requests[0].args.target, '@e91_1');
  assert.equal(fake.requests[0].args.after, 'auto');
});

test('click 成功: after=none 模式', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      data: {
        clicked: true,
        after: 'none',
        settle: { settled: true, elapsedMs: 50 },
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click(
    { target: 'css=.search-button', after: 'none' },
    client,
  );

  assert.equal(result.ok, true);
  assert.ok(result.summary.includes('点击'));
  assert.ok(result.data);
  assert.equal(result.data.clicked, true);
  assert.equal(result.data.changeSummary, undefined);
  assert.equal(result.data.postSnapshot, undefined);

  // 验证 CSS 选择器格式的 target 传递正确
  assert.equal(fake.requests[0].args.target, 'css=.search-button');
  assert.equal(fake.requests[0].args.after, 'none');
});

test('click 成功: after=snapshot 模式（含 postSnapshot YAML 树）', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'click',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 300,
      data: {
        clicked: true,
        after: 'snapshot',
        settle: { settled: true, elapsedMs: 280 },
        changes: {
          baselineId: 'click_abc',
          summary: 'Page navigated to search results.',
          textDiff: {
            addedText: ['Search Results', 'Result 1', 'Result 2'],
            removedText: ['Search button'],
            truncated: false,
          },
        },
        postSnapshot: {
          snapshot: POST_SNAPSHOT_YAML,
          refs: [
            '@e59_1',
            '@e63_1',
            '@e70_1',
            '@e71_1',
            '@e75_1',
          ],
          url: 'https://example.com/search',
          title: 'Search Results',
          stats: { totalNodes: 50, emitted: 5, refs: 5 },
        },
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await click({ target: '@e75_1', after: 'snapshot' }, client);

  assert.equal(result.ok, true);
  assert.ok(result.summary.includes('点击'));
  assert.ok(result.summary.includes('快照'));
  assert.ok(result.summary.includes('5'));

  assert.ok(result.data);
  assert.equal(result.data.clicked, true);

  // postSnapshot 验证
  assert.ok(result.data.postSnapshot);
  assert.equal(result.data.postSnapshot.elementCount, 5);
  assert.ok(result.data.postSnapshot.tree.includes('@e59_1'));
  assert.ok(result.data.postSnapshot.tree.includes('heading'));
  assert.ok(result.data.postSnapshot.tree.includes('Result 1'));

  // 验证 daemon 参数
  assert.equal(fake.requests[0].args.target, '@e75_1');
  assert.equal(fake.requests[0].args.after, 'snapshot');
});

test('click 失败: 缺少 target 参数', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await click({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /target|参数/);
  assert.equal(result.data, undefined);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});

test('click 失败: 无效 target 格式', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await click({ target: 'just-some-text' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /target|参数|格式|@e|css/);
  assert.equal(result.data, undefined);
});

test('click 失败: daemon 返回错误（元素未找到）', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'click',
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

  const result = await click({ target: '@e999_1' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});
