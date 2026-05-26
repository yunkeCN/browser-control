'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { saveAsPdf } = loadSourceModule('src/controller/commands/save-as-pdf.ts');

test('save_as_pdf 成功: 默认选项', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'save_as_pdf',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1200,
      data: {
        filePath: '/tmp/pdfs/2026-05-26_14-30-00.pdf',
        fileName: '2026-05-26_14-30-00.pdf',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await saveAsPdf({}, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /PDF 已保存到/);
  assert.match(result.summary, /\.pdf/);

  assert.ok(result.data);
  assert.equal(result.data.filePath, '/tmp/pdfs/2026-05-26_14-30-00.pdf');
  assert.equal(result.data.fileName, '2026-05-26_14-30-00.pdf');
  assert.equal(result.nextSteps, undefined);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'save_as_pdf');
});

test('save_as_pdf 成功: 自定义选项', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'save_as_pdf',
      backend: 'extension',
      session: envelope.session,
      tab: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1500,
      data: {
        filePath: '/tmp/pdfs/custom-report.pdf',
        fileName: 'custom-report.pdf',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await saveAsPdf(
    {
      paperFormat: 'A4',
      landscape: true,
      scale: 0.8,
      printBackground: false,
      fileName: 'custom-report',
    },
    client,
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /custom-report/);
  assert.equal(result.data.filePath, '/tmp/pdfs/custom-report.pdf');
  assert.equal(result.data.fileName, 'custom-report.pdf');

  assert.equal(fake.requests[0].args.paperFormat, 'A4');
  assert.equal(fake.requests[0].args.landscape, true);
  assert.equal(fake.requests[0].args.scale, 0.8);
  assert.equal(fake.requests[0].args.printBackground, false);
  assert.equal(fake.requests[0].args.fileName, 'custom-report');
});

test('save_as_pdf 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'save_as_pdf',
      session: 'test',
      error: {
        code: 'BACKEND_ERROR',
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

  const result = await saveAsPdf({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /no active tab/i);
  assert.ok(Array.isArray(result.nextSteps));
});
