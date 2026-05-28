import type { CommandResult } from '@controller/types';
import { clickDef } from '@controller/commands/click';
import { snapshotDef } from '@controller/commands/snapshot';

// ─── Command metadata ──────────────────────────────────────────────

export interface CommandMeta {
  name: string;
  required: string[];
  example: Record<string, unknown>;
  /** Transform raw daemon HTTP response into controller-aligned CommandResult */
  toResult: (raw: Record<string, unknown>, command: string) => CommandResult;
}

type RawData = Record<string, unknown> | undefined;

function fail(summary: string, nextSteps?: string[]): CommandResult {
  return { ok: false, summary, nextSteps };
}

function ok<T extends Record<string, unknown>>(summary: string, data?: T): CommandResult<T> {
  return { ok: true, summary, ...data };
}

// ─── Per-command toResult implementations ──────────────────────────

function navigateResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d || !d.url) return fail('导航失败: daemon 未返回导航结果', ['请重试或检查目标 URL 是否可访问']);
  return ok(`已导航到 ${d.url}`, {
    finalUrl: String(d.url),
    title: String(d.title || ''),
    tabId: Number(d.tabId) || 0,
  });
}

const snapshotResult = snapshotDef.toResult;

const clickResult = clickDef.toResult;

function fillResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('填充失败: daemon 未返回填充结果', ['请确认目标元素仍存在于页面中', '重试 fill 命令']);
  return ok(`已填写元素 ${d.target} | 输入内容: ${d.value}`, {
    filled: true,
    changeSummary: d.changeSummary ? String(d.changeSummary) : undefined,
  });
}

function pressResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('按键失败: daemon 未返回结果');
  return ok(`已按键: ${d.key || '?'}`);
}

function scrollResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  const pos = d?.position ? ` | ${d.position}` : '';
  return ok(`已滚动页面${pos}`);
}

function evaluateResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('JS 执行失败: daemon 未返回结果');
  return ok(`JS 执行完成 | 返回类型: ${typeof d.result}`, { result: d.result });
}

function getTextResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('获取文本失败: daemon 未返回结果');
  const text = String(d.text || '');
  const truncated = d.truncated;
  return ok(`页面文本: 获取到 ${text.length} 个字符${truncated ? '（已截断）' : '（完整文本）'}`, {
    text: text.slice(0, 500) + (text.length > 500 ? '...' : ''),
    charCount: text.length,
    truncated: Boolean(truncated),
  });
}

function screenshotResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('截图失败: daemon 未返回结果');
  return ok(`截图已保存到 ${d.filePath || d.file_name || 'screenshot.png'}`);
}

function waitForResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('等待失败: daemon 未返回结果');
  return ok(`等待成功: ${d.target || d.selector || d.text || '条件'}已变为 ${d.state || 'visible'}`);
}


function networkStartResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  const filter = d?.filter ? `（filter: ${d.filter}）` : '';
  return ok(`网络监控已启动${filter}`);
}

function networkListResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  const requests = d?.requests || d?.entries || d?.items;
  const count = Array.isArray(requests) ? requests.length : 0;
  return ok(`网络请求: 捕获到 ${count} 个请求`, { requests, count });
}

function networkDetailResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('请求详情获取失败');
  return ok(`请求详情: ${d.method || 'GET'} ${d.url} -> ${d.statusCode || d.status || '?'}`);
}

function networkStopResult(_raw: Record<string, unknown>): CommandResult {
  return ok('网络监控已停止');
}

function listTabsResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  const tabs = d?.tabs;
  const count = Array.isArray(tabs) ? tabs.length : 0;
  return ok(`标签页列表: ${count} 个标签页`, { tabs, count });
}

function findTabResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('未找到匹配的标签页');
  return ok(`找到标签页: "${d.title || d.url}"（tabId=${d.tabId || d.id}）`, { tabId: d.tabId || d.id, title: d.title, url: d.url });
}

function closeTabResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  return ok(`已关闭标签页 tabId=${d?.tabId || '?'}`);
}

function closeSessionResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  return ok(`会话已关闭 | 当前活跃会话: ${d?.activeSession || 'default'}`);
}


function saveAsPdfResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('PDF 保存失败');
  return ok(`PDF 已保存到 ${d.filePath || d.file_name || 'output.pdf'}`);
}

function downloadResult(raw: Record<string, unknown>): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('下载失败');
  return ok(`已下载来自 ${d.url} 的文件`);
}

function uploadResult(raw: Record<string, unknown>, command: string): CommandResult {
  const d = raw.data as RawData;
  if (!d) return fail('上传失败');
  const files = d.files;
  const count = Array.isArray(files) ? files.length : 1;
  return ok(`已上传 ${count} 个文件到元素 ${d.target || '?'}`);
}

// ─── Registry ──────────────────────────────────────────────────────

type ToResultFn = (raw: Record<string, unknown>, command: string) => CommandResult;


export const COMMAND_META: Record<string, CommandMeta> = {
  navigate: {
    name: 'navigate',
    required: ['url'],
    example: { url: 'https://example.com', newTab: true },
    toResult: navigateResult,
  },
  tabs: {
    name: 'tabs',
    required: [],
    example: { action: 'list' },
    toResult: listTabsResult,
  },
  snapshot: {
    name: 'snapshot',
    required: [],
    example: { viewportOnly: false, hasVisibleText: true, boxes: true },
    toResult: snapshotResult,
  },
  click: {
    name: 'click',
    required: ['target'],
    example: { target: '@e1abc_1', after: 'auto' },
    toResult: clickResult,
  },
  fill: {
    name: 'fill',
    required: ['target', 'value'],
    example: { target: '@e1input_2', value: 'sample text', clear: true },
    toResult: fillResult,
  },
  press: {
    name: 'press',
    required: ['key'],
    example: { key: 'Enter' },
    toResult: pressResult,
  },
  scroll: {
    name: 'scroll',
    required: [],
    example: { deltaY: 800, strategy: 'dom' },
    toResult: scrollResult,
  },
  wait_for: {
    name: 'wait_for',
    required: [],
    example: { text: 'Ready', timeoutMs: 5000 },
    toResult: waitForResult,
  },
  evaluate: {
    name: 'evaluate',
    required: ['code'],
    example: { code: 'return { title: document.title, url: location.href }' },
    toResult: evaluateResult,
  },
  capture: {
    name: 'capture',
    required: [],
    example: { format: 'png' },
    toResult: screenshotResult,
  },
  network: {
    name: 'network',
    required: ['action'],
    example: { action: 'start', filter: '/api/' },
    toResult: networkListResult,
  },
  upload: {
    name: 'upload',
    required: ['target', 'files'],
    example: { target: '@e1file_4', files: ['/tmp/example.png'] },
    toResult: uploadResult,
  },
  download: {
    name: 'download',
    required: ['url'],
    example: { url: 'https://example.com/file.zip', filename: 'file.zip' },
    toResult: downloadResult,
  },
  get_text: {
    name: 'get_text',
    required: [],
    example: { scope: 'full', maxChars: 4000, includeRuns: true },
    toResult: getTextResult,
  },
  close_session: {
    name: 'close_session',
    required: [],
    example: {},
    toResult: closeSessionResult,
  },
};
