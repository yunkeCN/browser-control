'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { snapshot } = loadSourceModule('src/controller/commands/snapshot.ts');

/** YAML 树格式快照示例（与 Playwright MCP 格式一致） */
const SAMPLE_TREE_YAML = [
  '- complementary "Debug console navigation" [ref=@e3_1]:',
  '  - paragraph [ref=@e10_1]: Browser Control',
  '  - heading "Debug Console" [level=1] [ref=@e11_1]',
  '  - textbox "Daemon endpoint" [ref=@e16_1]: http://127.0.0.1:10087',
  '  - button "Refresh daemon status" [ref=@e17_1] [cursor=pointer]',
  '    - img [ref=@e18_1]',
  '  - region "Sessions" [ref=@e22_1]:',
  '    - heading "Sessions" [level=2] [ref=@e24_1]',
  '    - button "New" [ref=@e25_1] [cursor=pointer]',
  '- main [ref=@e59_1]:',
  '  - heading "Command Workbench" [level=2] [ref=@e63_1]',
  '  - combobox "Command" [ref=@e91_1] [cursor=pointer]',
  '    - option "navigate" [selected]',
  '    - option "snapshot"',
  '    - option "click"',
].join('\n');

/**
 * snapshot 集成测试
 *
 * execute() 返回 response.data（daemon 响应体整体）
 * toResult(raw) 从 raw.data 中读取 title / url / snapshot / tree / stats.elementCount / refs / baselineTree / diff
 * 成功时 CommandResult 是扁平的: { ok, summary, baselineId?, title, url, tree, elementCount, diff? }
 */

// ─── 测试用例 ────────────────────────────────────────────────────

test('snapshot 成功: 返回 LLM-friendly 格式（含 YAML 树）', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'snapshot',
      backend: 'extension',
      session: envelope.session,
      tab: 108,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 150,
      data: {
        snapshot: SAMPLE_TREE_YAML,
        refs: ['@e3_1', '@e10_1', '@e11_1', '@e16_1', '@e17_1', '@e18_1', '@e22_1', '@e24_1', '@e25_1', '@e59_1', '@e63_1', '@e91_1'],
        url: 'https://example.com/debug',
        title: 'Browser Control Fixture',
        stats: { totalNodes: 1284, emitted: 42, refs: 12 },
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await snapshot({ viewportOnly: true }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /快照/);
  assert.match(result.summary, /12.*元素/);
  assert.match(result.summary, /Browser Control Fixture/);

  // 扁平字段验证
  assert.equal(result.title, 'Browser Control Fixture');
  assert.equal(result.url, 'https://example.com/debug');
  assert.equal(result.elementCount, 12);
  assert.ok(result.tree.includes('@e3_1'), 'YAML 树应包含 @e 引用');
  assert.ok(result.tree.includes('textbox'), 'YAML 树应包含角色信息');
  assert.ok(result.tree.includes('heading'), 'YAML 树应包含标题');
  assert.ok(result.tree.includes('combo'), 'YAML 树应包含组合框');

  // 验证传递给 daemon 的参数
  assert.equal(fake.requests[0].command, 'snapshot');
  assert.equal(fake.requests[0].args.viewportOnly, true);
});

test('snapshot 成功: 带过滤条件', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'snapshot',
      backend: 'extension',
      session: envelope.session,
      tab: 200,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      data: {
        snapshot: SAMPLE_TREE_YAML,
        refs: ['@e3_1', '@e11_1', '@e17_1'],
        url: 'https://example.com',
        title: 'Filtered Page',
        stats: { totalNodes: 500, emitted: 3, refs: 3 },
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await snapshot(
    { roles: ['button', 'textbox'], hasVisibleText: true },
    client,
  );

  assert.equal(result.ok, true);
  assert.equal(result.elementCount, 3);
  assert.equal(fake.requests[0].args.roles[0], 'button');
  assert.equal(fake.requests[0].args.hasVisibleText, true);
});

test('snapshot 成功: 空页面', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: true,
      command: 'snapshot',
      data: {
        snapshot: '- paragraph: Empty page',
        refs: [],
        url: 'https://empty.com',
        title: 'Empty',
        stats: { totalNodes: 1, emitted: 0, refs: 0 },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await snapshot({}, client);

  assert.equal(result.ok, true);
  assert.equal(result.elementCount, 0);
  assert.match(result.summary, /0.*元素/);
});

test('snapshot 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'snapshot',
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

  const result = await snapshot({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /no active tab/i);
  assert.ok(Array.isArray(result.nextSteps));
});

test('snapshot 失败: daemon 无响应', async (t) => {
  const client = new DaemonClient({ port: 18998, host: '127.0.0.1' });

  const result = await snapshot({ viewportOnly: true }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /daemon|connect|refused|timeout|econnrefused/i);
  assert.ok(Array.isArray(result.nextSteps));
});
