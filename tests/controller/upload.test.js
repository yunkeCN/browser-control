'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

// 加载 TypeScript 源文件
const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { upload } = loadSourceModule('src/controller/commands/upload.ts');

/**
 * upload 集成测试
 *
 * 使用真实 HTTP fake daemon 测试 upload 命令的完整执行流程：
 * validate -> execute daemon -> handle errors -> toResult -> CommandResult
 */

test('upload 成功: 上传单个文件', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'upload',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: '2026-05-25T00:00:00.001Z',
      durationMs: 200,
      data: {
        uploaded: true,
        fileCount: 1,
        target: '@e1abc_1',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await upload(
    { target: '@e1abc_1', files: ['/tmp/photo.jpg'] },
    client,
  );

  // 核心断言: ok + summary + data
  assert.equal(result.ok, true, 'ok 应为 true');
  assert.match(result.summary, /上传/, 'summary 应包含「上传」');
  assert.match(result.summary, /1 个/, 'summary 应包含文件数量');
  assert.match(result.summary, /@e1abc_1/, 'summary 应包含目标元素');

  // data 验证
  assert.ok(result.data, '成功时应有 data');
  assert.equal(result.data.uploaded, true);
  assert.equal(result.data.fileCount, 1);

  // 成功无 nextSteps
  assert.equal(result.nextSteps, undefined);

  // 验证 daemon 实际收到了正确的请求
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'upload');
  assert.deepEqual(fake.requests[0].args.target, '@e1abc_1');
  assert.deepEqual(fake.requests[0].args.files, ['/tmp/photo.jpg']);
});

test('upload 成功: 上传多个文件', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'upload',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 500,
      data: {
        uploaded: true,
        fileCount: 2,
        target: 'css=#file-input',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await upload(
    {
      target: 'css=#file-input',
      files: ['/tmp/doc1.pdf', '/tmp/doc2.pdf'],
    },
    client,
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.uploaded, true);
  assert.equal(result.data.fileCount, 2);
  assert.match(result.summary, /2 个/);

  // 验证传递给 daemon 的参数
  assert.equal(fake.requests[0].args.target, 'css=#file-input');
  assert.deepEqual(fake.requests[0].args.files, [
    '/tmp/doc1.pdf',
    '/tmp/doc2.pdf',
  ]);
});

test('upload 失败: 缺少 target', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await upload({ files: ['/tmp/photo.jpg'] }, client);

  assert.equal(result.ok, false, '无 target 时应返回错误');
  assert.match(result.summary, /target|参数/, 'summary 应提示缺少 target');
  assert.equal(result.data, undefined, '失败时不应有 data');
  assert.ok(Array.isArray(result.nextSteps), '验证失败时应提供 nextSteps');
});

test('upload 失败: files 不是数组', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await upload(
    { target: '@e1abc_1', files: '/tmp/photo.jpg' },
    client,
  );

  assert.equal(result.ok, false);
  assert.match(result.summary, /数组|array|files/i);
  assert.equal(result.data, undefined);
  assert.ok(Array.isArray(result.nextSteps));
});

test('upload 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'upload',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
        message: 'Upload failed: element does not accept file input',
        retryable: false,
        details: {
          nextSteps: [
            'Use snapshot to verify the element supports file upload.',
            'Target a different element that is a file input.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await upload(
    { target: '@e1abc_1', files: ['/tmp/photo.jpg'] },
    client,
  );

  assert.equal(result.ok, false);
  assert.match(result.summary, /upload|failed|file/i);
  assert.ok(Array.isArray(result.nextSteps), '错误时应提供 nextSteps');
  assert.ok(result.nextSteps.length > 0, 'nextSteps 不应为空');
});
