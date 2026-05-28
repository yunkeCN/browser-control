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

// button "新增分支" center = (1255, 91)
// generic "请选择分支类型" center = (874, 193)

test('click_text 成功: 有 ref 的用 click 命令，坐标精确', async (t) => {
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
  const result = await clickText({ text: '新增分支', x: 1255, y: 91 }, client);
  assert.equal(result.ok, true);
  assert.equal(result.data.method, 'ref');
  assert.equal(result.data.ref, '@eyws8mg_1');
  assert.ok(result.data.distance < 10);
  assert.equal(result.data.candidateCount, 1);
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
  const result = await clickText({ text: '请选择分支类型', x: 870, y: 190 }, client);
  assert.equal(result.ok, true);
  assert.equal(result.data.method, 'cdp');
  assert.equal(result.data.matchedText, '请选择分支类型');
  assert.ok(result.data.distance < 20);
  assert.equal(result.data.candidateCount, 1);
  assert.ok(result.data.boxCenterX && result.data.boxCenterY);
  assert.deepEqual(calls, ['snapshot', 'cdp_click_at']);
});

test('click_text: 多候选时选距离最近的', async (t) => {
  // "请选择分支类型" generic at center (874, 193), user clicks near (200, 140)
  // only 1 candidate matches "请选择分支类型", distance ~676px
  const fake = createFakeDaemon({
    onCommand: function(e) {
      if (e.command === 'snapshot') return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: [], url: '', title: '' } };
      if (e.command === 'cdp_click_at') return { ok: true, command: 'cdp_click_at', data: { clicked: true, x: e.args.x, y: e.args.y } };
      return { ok: true, data: {} };
    },
  });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });

  // generic "请选择分支类型" has no ref, only 1 candidate for this text
  const result = await clickText({ text: '请选择分支类型', x: 200, y: 140 }, client);
  assert.equal(result.ok, true);
  assert.equal(result.data.method, 'cdp');
  assert.equal(result.data.matchedText, '请选择分支类型');
  assert.equal(result.data.candidateCount, 1);
  // distance from (200,140) to (874,193) is large
  assert.ok(result.data.distance > 600);
});

test('click_text: 距离过远触发坐标偏差警告', async (t) => {
  const fake = createFakeDaemon({
    onCommand: function(e) {
      if (e.command === 'snapshot') return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: ['@eyws8mg_1'], url: '', title: '' } };
      if (e.command === 'click') return { ok: true, command: 'click', data: { clicked: true } };
      return { ok: true, data: {} };
    },
  });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  // button "新增分支" at (1255, 91), user gives far coords (10, 10)
  const result = await clickText({ text: '新增分支', x: 10, y: 10 }, client);
  assert.equal(result.ok, true);
  assert.ok(result.data.distance > 1200);
  assert.ok(result.riskNotes?.length > 0);
  assert.match(result.riskNotes[0], /可能点击了非预期元素/);
  assert.match(result.summary, /⚠/);
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
  const result = await clickText({ text: '请选择分支类型', x: 870, y: 190 }, client);
  assert.equal(result.ok, false);
});

test('click_text: 未找到匹配文本', async (t) => {
  const fake = createFakeDaemon({ onCommand: function() { return { ok: true, command: 'snapshot', data: { snapshot: SAMPLE_TREE, refs: [], url: '', title: '' } }; } });
  await fake.listen();
  t.after(function() { return fake.close(); });
  const client = new DaemonClient({ port: fake.port(), host: '127.0.0.1' });
  const result = await clickText({ text: '不存在的文本', x: 100, y: 100 }, client);
  assert.equal(result.ok, false);
  assert.match(result.summary, /未找到/);
});

test('click_text: 缺少 text 参数', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });
  const result = await clickText({ x: 100, y: 100 }, client);
  assert.equal(result.ok, false);
  assert.match(result.summary, /参数/);
});

test('click_text: 缺少 x 参数', async (t) => {
  const client = new DaemonClient({ port: 1, host: '127.0.0.1' });
  const result = await clickText({ text: 'Submit' }, client);
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
  const result = await clickText({ text: '新增分支', roles: ['button'], x: 1255, y: 91 }, client);
  assert.equal(result.ok, true);
  assert.equal(result.data.method, 'ref');
});
