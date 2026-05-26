'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { networkStart, networkList, networkDetail, networkStop } = loadSourceModule(
  'src/controller/commands/network.ts',
);

// ─── 测试用例 ────────────────────────────────────────────────────

test('network_start 成功: 启动网络监控', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'network_start',
      backend: 'extension',
      session: envelope.session,
      tab: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 50,
      data: {
        started: true,
        filter: '/api/',
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await networkStart({ filter: '/api/' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /网络监控已启动/);
  assert.match(result.summary, /\/api\//);

  assert.ok(result.data);
  assert.equal(result.data.started, true);
  assert.equal(result.data.filter, '/api/');

  // 验证传递给 daemon 的参数
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].command, 'network_start');
  assert.equal(fake.requests[0].args.filter, '/api/');
});

test('network_list 成功: 有请求', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'network_list',
      backend: 'extension',
      session: envelope.session,
      tab: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 30,
      data: {
        count: 2,
        requests: [
          {
            id: 'req_001',
            method: 'GET',
            url: 'https://api.example.com/data',
            statusCode: 200,
          },
          {
            id: 'req_002',
            method: 'POST',
            url: 'https://api.example.com/submit',
            statusCode: 201,
          },
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

  const result = await networkList({ limit: 10 }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /2.*请求/);

  assert.ok(result.data);
  assert.equal(result.data.count, 2);
  assert.equal(result.data.requests.length, 2);
  assert.equal(result.data.requests[0].id, 'req_001');
  assert.equal(result.data.requests[0].method, 'GET');
  assert.equal(result.data.requests[0].statusCode, 200);
  assert.equal(result.data.requests[1].method, 'POST');

  assert.equal(fake.requests[0].command, 'network_list');
  assert.equal(fake.requests[0].args.limit, 10);
});

test('network_list 成功: 空列表', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: true,
      command: 'network_list',
      data: {
        count: 0,
        requests: [],
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await networkList({}, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /0.*请求/);

  assert.ok(result.data);
  assert.equal(result.data.count, 0);
  assert.equal(result.data.requests.length, 0);
});

test('network_detail 成功: 获取请求详情', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'network_detail',
      backend: 'extension',
      session: envelope.session,
      tab: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 20,
      data: {
        request: {
          method: 'GET',
          url: 'https://api.example.com/data',
          statusCode: 200,
        },
        response: {
          statusCode: 200,
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

  const result = await networkDetail({ requestId: 'req_001' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /GET/);
  assert.match(result.summary, /api\.example\.com/);
  assert.match(result.summary, /200/);

  assert.ok(result.data);
  assert.equal(result.data.request.method, 'GET');
  assert.equal(result.data.request.url, 'https://api.example.com/data');
  assert.equal(result.data.request.statusCode, 200);
  assert.ok(result.data.response);
  assert.equal(result.data.response.statusCode, 200);

  assert.equal(fake.requests[0].command, 'network_detail');
  assert.equal(fake.requests[0].args.requestId, 'req_001');
});

test('network_stop 成功: 停止网络监控', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'network_stop',
      backend: 'extension',
      session: envelope.session,
      tab: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 30,
      data: {
        stopped: true,
      },
      artifacts: [],
      error: null,
      diagnostics: null,
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await networkStop({}, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /网络监控已停止/);

  assert.ok(result.data);
  assert.equal(result.data.stopped, true);

  assert.equal(fake.requests[0].command, 'network_stop');
});

test('network_start 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'network_start',
      session: 'test',
      error: {
        code: 'MONITORING_ALREADY_ACTIVE',
        message: 'Network monitoring is already active',
        retryable: false,
        details: {
          nextSteps: ['Use network_stop first to stop the current monitoring session.'],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await networkStart({ filter: '/api/' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /already active/i);
  assert.ok(Array.isArray(result.nextSteps));
});

test('network_detail 失败: 缺少 requestId', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });

  const result = await networkDetail({}, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /requestId/);
  assert.equal(result.data, undefined);
  assert.ok(Array.isArray(result.nextSteps));
});

test('network_detail 失败: daemon 返回错误', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: false,
      command: 'network_detail',
      session: 'test',
      error: {
        code: 'REQUEST_NOT_FOUND',
        message: 'Request not found: req_invalid',
        retryable: false,
        details: {
          nextSteps: [
            'Use network_list to find valid request IDs.',
          ],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  const result = await networkDetail({ requestId: 'req_invalid' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
});
