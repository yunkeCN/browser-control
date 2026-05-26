'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDaemon } = require('../helpers/fake-daemon');
const { loadSourceModule } = require('../helpers/load-source-module');

const { DaemonClient } = loadSourceModule('src/mcp/daemon-client.ts');
const { clickText } = loadSourceModule('src/controller/commands/click-text.ts');

const SAMPLE_TREE = [
  '- complementary "Navigation" [ref=@e3_1] [box=0,50,100,706]:',
  '  - button "新增分支" [ref=@eyws8mg_1] [cursor=pointer] [box=1201,75,108,32]',
  '  - textbox "搜索" [ref=@e44_1] [box=152,137,200,22]',
  '  - combobox [ref=@e19g1lb2_1] [box=816,178,102,30]',
  '  - generic [box=816,178,116,30]: "请选择分支类型"',
  '  - option "feature" [box=400,240,200,24]',
].join('\n');

test('click_text 成功: 有 ref 的用 click 命令', async (t) => {
  const calls = [];
  const fake = createFakeDaemon({
    onCommand: function(e) {
      calls.push(e.command);
      if (e.command === 'snapshot') return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: ['@eyws8mg_1'], url: '', title: '' } };
      if (e.command === 'click') return { ok: true, command: 'click', data: { clicked: true } };
      return { ok: true, data: {} };
    },
  });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await clickText({ text: '新增分支' }, client);
  assert.equal(result.ok, true);
  assert.equal(result.data.method, 'ref');
  assert.equal(result.data.ref, '@eyws8mg_1');
  assert.deepEqual(calls, ['snapshot', 'click']);
});

test('click_text 成功: 无 ref 用 CDP 坐标点击', async (t) => {
  const calls = [];
  const fake = createFakeDaemon({
    onCommand: function(e) {
      calls.push(e.command);
      if (e.command === 'snapshot') return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: [], url: '', title: '' } };
      if (e.command === 'cdp_click_at') return { ok: true, command: 'cdp_click_at', data: { clicked: true, x: e.args.x, y: e.args.y } };
      return { ok: true, data: {} };
    },
  });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await clickText({ text: '请选择分支类型' }, client);
  assert.equal(result.ok, true);
  assert.equal(result.data.method, 'cdp');
  assert.equal(result.data.matchedText, '请选择分支类型');
  assert.ok(result.data.boxCenterX && result.data.boxCenterY);
  assert.deepEqual(calls, ['snapshot', 'cdp_click_at']);
});

test('click_text: CDP 坐标点击失败', async (t) => {
  const fake = createFakeDaemon({
    onCommand: function(e) {
      if (e.command === 'snapshot') return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: [], url: '', title: '' } };
      return { ok: false, command: 'cdp_click_at', error: { message: 'no tab session' } };
    },
  });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await clickText({ text: '请选择分支类型' }, client);
  assert.equal(result.ok, false);
});

test('click_text: 未找到匹配文本', async (t) => {
  const fake = createFakeDaemon({ onCommand: function() { return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: [], url: '', title: '' } }; } });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await clickText({ text: '不存在的文本' }, client);
  assert.equal(result.ok, false);
  assert.match(result.summary, /未找到/);
});

test('click_text: 缺少 text 参数', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });
  const result = await clickText({}, client);
  assert.equal(result.ok, false);
  assert.match(result.summary, /参数/);
});

test('click_text: 按角色过滤', async (t) => {
  const fake = createFakeDaemon({
    onCommand: function(e) {
      if (e.command === 'snapshot') return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: ['@eyws8mg_1'], url: '', title: '' } };
      return { ok: true, command: 'click', data: { clicked: true } };
    },
  });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await clickText({ text: '新增分支', roles: ['button'] }, client);
  assert.equal(result.ok, true);
  assert.equal(result.data.method, 'ref');
});
