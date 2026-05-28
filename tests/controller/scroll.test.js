'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

// 加载 TypeScript 源文件
const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { scroll } = loadSourceModule('src/controller/commands/scroll.ts');

/**
 * scroll 集成测试
 *
 * 使用真实 HTTP fake daemon 测试 scroll 命令的完整执行流程：
 * validate -> execute daemon -> handle errors -> toResult -> CommandResult
 *
 * execute() 返回 response.data（即 daemon 响应体整体）
 * toResult(raw) 从 raw.data 中读取 scrolled / newPosition
 * 成功时 CommandResult 是扁平的: { ok, summary, scrolled, newPosition? }
 */

test('scroll 成功: 基本滚动（deltaY）', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'scroll',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: '2026-05-25T00:00:00.001Z',
      durationMs: 50,
      data: {
        scrolled: true,
        newPosition: '已滚动到 x=0, y=800',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await scroll({ deltaY: 800 }, client);

  // 核心断言: ok + summary（扁平结构）
  assert.equal(result.ok, true, 'ok 应为 true');
  assert.match(result.summary, /滚动/, 'summary 应包含「滚动」');
  assert.match(result.summary, /已滚动到 x=0, y=800/, 'summary 应包含滚动位置');

  // 扁平字段验证（不再嵌套在 result.data 中）
  assert.equal(result.scrolled, true);
  assert.equal(result.newPosition, '已滚动到 x=0, y=800');

  // 成功无 nextSteps
  assert.equal(result.nextSteps, undefined);

  // 验证 daemon 实际收到了正确的请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'scroll');
  assert.deepEqual(fake.requests[0].args, { deltaY: 800 });
});

test('scroll 成功: 带 deltaX 和 deltaY', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'scroll',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 60,
      data: {
        scrolled: true,
        newPosition: '已滚动到 x=300, y=500',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await scroll({ deltaX: 300, deltaY: 500 }, client);

  assert.equal(result.ok, true);
  assert.equal(result.scrolled, true);
  assert.equal(result.newPosition, '已滚动到 x=300, y=500');

  // 验证传递给 daemon 的参数
  assert.equal(fake.requests[0].args.deltaX, 300);
  assert.equal(fake.requests[0].args.deltaY, 500);
});

test('scroll 成功: accepts extension ok/movement shape and passes diagnostics through', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'scroll',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      data: {
        ok: true,
        strategyUsed: 'wheel',
        before: { scrollX: 0, scrollY: 0 },
        after: { scrollX: 0, scrollY: 600 },
        movedX: 0,
        movedY: 600,
        warnings: ['measured by wheel'],
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await scroll({ strategy: 'wheel', x: 400, y: 300, deltaY: 600 }, client);

  assert.equal(result.ok, true);
  assert.equal(result.scrolled, true);
  assert.equal(result.strategyUsed, 'wheel');
  assert.equal(result.movedY, 600);
  assert.deepEqual(result.before, { scrollX: 0, scrollY: 0 });
  assert.deepEqual(result.after, { scrollX: 0, scrollY: 600 });
  assert.deepEqual(result.warnings, ['measured by wheel']);
});

test('scroll 失败: scrolled=false 时返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'scroll',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 30,
      data: {
        scrolled: false,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await scroll({ deltaY: 200 }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /滚动未生效/);
});

test('scroll 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'scroll',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'Scroll failed: element is not scrollable',
        retryable: false,
        details: {
          nextSteps: [
            'Check if the element exists and is scrollable.',
            'Try scrolling the page instead of a specific element.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await scroll({ deltaY: 200 }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /failed|scrollable/i);
  assert.ok(Array.isArray(result.nextSteps), '错误时应提供 nextSteps');
  assert.ok(result.nextSteps.length > 0, 'nextSteps 不应为空');
});

test('scroll 失败: daemon 无响应', async (t) => {
  // 使用一个不可能连接的端口
  const client = new DaemonClient({ port: 18999, host: '127.0.0.1' });

  const result = await scroll({ deltaY: 500 }, client);

  assert.equal(result.ok, false);
  assert.match(
    result.summary,
    /daemon|connect|refused/i,
    'daemon 无响应时应有明确提示',
  );
  assert.ok(Array.isArray(result.nextSteps));
});
