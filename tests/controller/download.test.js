'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

// 加载 TypeScript 源文件
const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { download } = loadSourceModule('src/controller/commands/download.ts');

/**
 * download 集成测试
 *
 * 使用真实 HTTP fake daemon 测试 download 命令的完整执行流程：
 * validate -> execute daemon -> handle errors -> toResult -> CommandResult
 */

test('download 成功: 下载文件', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'download',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: '2026-05-25T00:00:00.001Z',
      durationMs: 1200,
      data: {
        downloaded: true,
        url: 'https://example.com/file.pdf',
        filename: 'file.pdf',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await download(
    { url: 'https://example.com/file.pdf' },
    client,
  );

  // 核心断言: ok + summary + data
  assert.equal(result.ok, true, 'ok 应为 true');
  assert.match(result.summary, /下载/, 'summary 应包含「下载」');
  assert.match(result.summary, /example\.com/, 'summary 应包含 URL');

  // 字段验证
  assert.equal(result.downloaded, true);
  assert.equal(result.url, 'https://example.com/file.pdf');
  assert.equal(result.filename, 'file.pdf');

  // 成功无 nextSteps
  assert.equal(result.nextSteps, undefined);

  // 验证 daemon 实际收到了正确的请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'download');
  assert.deepEqual(fake.requests[0].args.url, 'https://example.com/file.pdf');
});

test('download 失败: 缺少 url', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await download({}, client);

  assert.equal(result.ok, false, '无 url 时应返回错误');
  assert.match(result.summary, /url|有效|非空/, 'summary 应提示缺少 url');
  assert.ok(Array.isArray(result.nextSteps), '验证失败时应提供 nextSteps');
});

test('download 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'download',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'Download failed: connection refused to https://example.com/file.pdf',
        retryable: true,
        details: {
          nextSteps: [
            'Check the URL is accessible from the browser.',
            'Retry the download command.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await download(
    { url: 'https://example.com/file.pdf' },
    client,
  );

  assert.equal(result.ok, false);
  assert.match(result.summary, /download|failed|error|下载|失败/i);
  assert.ok(Array.isArray(result.nextSteps), '错误时应提供 nextSteps');
  assert.ok(result.nextSteps.length > 0, 'nextSteps 不应为空');
});
