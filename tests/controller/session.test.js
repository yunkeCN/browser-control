'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { closeSession } = loadSourceModule(
  'src/controller/commands/session.ts',
);

/**
 * session 集成测试
 *
 * 使用真实 HTTP fake daemon 测试 closeSession 命令的完整执行流程：
 * validate -> execute daemon -> handle errors -> toResult -> CommandResult
 */

test('close_session 成功: 关闭当前会话', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'close_session',
      backend: 'extension',
      session: envelope.session,
      tab: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 50,
      data: {
        closed: true,
        activeSession: 'mcp-abc',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await closeSession({}, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /会话已关闭/);
  assert.match(result.summary, /mcp-abc/);

  assert.equal(result.closed, true);
  assert.equal(result.activeSession, 'mcp-abc');

  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'close_session');
});

test('close_session 成功: 指定会话 ID', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'close_session',
      backend: 'extension',
      session: envelope.session,
      tab: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 45,
      data: {
        closed: true,
        activeSession: 'mcp-xyz',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await closeSession({ session: 'my-session' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /mcp-xyz/);

  assert.equal(result.closed, true);

  assert.equal(fake.requests[0].session, 'my-session');
});

test('close_session 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'close_session',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'Session not found: test-session',
        retryable: false,
        details: {
          nextSteps: [
            'Check available sessions via list_sessions or daemon status.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await closeSession({ session: 'test-session' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length > 0);
});

test('close_session 失败: daemon 无响应', async (t) => {
  const client = new DaemonClient({ port: 18997, host: '127.0.0.1' });

  const result = await closeSession({}, client);

  assert.equal(result.ok, false);
  assert.match(
    result.summary,
    /daemon|connect|refused|timeout|econnrefused/i,
  );
  assert.ok(Array.isArray(result.nextSteps));
});
