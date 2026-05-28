'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { network } = loadSourceModule('src/controller/commands/network.ts');

// ─── list action ────────────────────────────────────────────────

test('network list 成功: 有请求', async (t) => {
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
          { id: 'req_001', method: 'GET', url: 'https://api.example.com/data', statusCode: 200 },
          { id: 'req_002', method: 'POST', url: 'https://api.example.com/submit', statusCode: 201 },
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
  const result = await network({ action: 'list', limit: 10 }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /2.*请求/);
  assert.equal(result.count, 2);
  assert.ok(Array.isArray(result.requests));
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[0].id, 'req_001');
  assert.equal(result.requests[0].method, 'GET');
  assert.equal(result.requests[1].method, 'POST');

  assert.equal(fake.requests[0].command, 'network_list');
  assert.equal(fake.requests[0].args.limit, 10);
});

test('network list 成功: 空列表', async (t) => {
  const fake = createFakeDaemon({
    onCommand: () => ({
      ok: true,
      command: 'network_list',
      data: { count: 0, requests: [] },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await network({ action: 'list' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /0.*请求/);
  assert.equal(result.count, 0);
  assert.ok(Array.isArray(result.requests));
  assert.equal(result.requests.length, 0);
});

test('network list 成功: 带 filter', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'network_list',
      data: {
        count: 1,
        requests: [
          { id: 'req_001', method: 'GET', url: 'https://api.example.com/users', statusCode: 200 },
        ],
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await network({ action: 'list', filter: '/users' }, client);

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(fake.requests[0].args.filter, '/users');
});

// ─── detail action ──────────────────────────────────────────────

test('network detail 成功: 获取请求详情', async (t) => {
  const fake = createFakeDaemon({
    onCommand: (envelope) => ({
      id: envelope.id,
      ok: true,
      command: 'network_detail',
      backend: 'extension',
      session: envelope.session,
      data: {
        request: { method: 'GET', url: 'https://api.example.com/data', statusCode: 200 },
        response: { statusCode: 200 },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await network({ action: 'detail', requestId: 'req_001' }, client);

  assert.equal(result.ok, true);
  assert.match(result.summary, /GET/);
  assert.match(result.summary, /api\.example\.com/);
  assert.match(result.summary, /200/);
  assert.equal(result.request.method, 'GET');
  assert.equal(result.request.url, 'https://api.example.com/data');
  assert.equal(result.response.statusCode, 200);

  assert.equal(fake.requests[0].command, 'network_detail');
  assert.equal(fake.requests[0].args.requestId, 'req_001');
});

// ─── 失败用例 ───────────────────────────────────────────────────

test('network 失败: 无效 action', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });
  const result = await network({ action: 'invalid' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /action/);
});

test('network detail 失败: 缺少 requestId', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });
  const result = await network({ action: 'detail' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /requestId/);
});

test('network 失败: filter 非字符串', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });
  const result = await network({ action: 'list', filter: 123 }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /filter/);
});

test('network 失败: daemon 返回错误', async (t) => {
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
          nextSteps: ['Use network action list to find valid request IDs.'],
        },
      },
    }),
  });
  await fake.listen();
  t.after(() => fake.close());

  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await network({ action: 'detail', requestId: 'req_invalid' }, client);

  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);
  assert.ok(Array.isArray(result.nextSteps));
});
