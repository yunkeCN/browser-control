/**
 * 点击探测 — 内部实现
 *
 * 通过 CDP Fetch.enable 主动拦截点击期间的网络请求。
 * 由统一 click 命令的 probe 模式调用。
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';

// ─── 类型定义 ────────────────────────────────────────────────────

export interface ClickProbeInput {
  target: string;
  tabId?: number;
  force?: boolean;
  filter?: string;
  includeHeaders?: boolean;
  includeBody?: boolean;
  redactSensitive?: boolean;
  maxRequests?: number;
}

export interface ClickProbeData {
  clicked: boolean;
  networkRequests?: Array<{
    url: string;
    method: string;
    statusCode?: number;
  }>;
  requestCount?: number;
}

// ─── 内部执行函数 ────────────────────────────────────────────────

export async function executeClickProbe(
  input: ClickProbeInput,
  daemon: DaemonClient,
): Promise<Record<string, unknown>> {
  const envelope = daemon.buildEnvelope(
    'click_probe',
    input as unknown as Record<string, unknown>,
  );
  const response = await daemon.command(envelope);
  const raw = response.data as Record<string, unknown>;
  // 标记为 probe 模式，供 toResult 识别
  return { ...raw, _mode: 'probe' };
}

export function toClickProbeResult(raw: Record<string, unknown>): CommandResult<ClickProbeData> {
  const clickData = raw.data as Record<string, unknown> | undefined;

  if (!clickData) {
    return {
      ok: false,
      summary: '点击探测失败: daemon 未返回结果',
      nextSteps: ['请确认目标元素在当前页面中存在', '重试 click 命令'],
    };
  }

  const clicked = Boolean(clickData.clicked);
  if (!clicked) {
    return {
      ok: false,
      summary: '点击未生效: 元素可能不可点击或已被移除',
      nextSteps: ['请使用 snapshot 刷新页面元素状态后重试'],
    };
  }

  const rawRequests = clickData.networkRequests;
  const networkRequests = Array.isArray(rawRequests)
    ? rawRequests.map((r: unknown) => {
        const req = r as Record<string, unknown>;
        return {
          url: String(req.url || ''),
          method: String(req.method || ''),
          statusCode: req.statusCode !== undefined ? Number(req.statusCode) : undefined,
        };
      })
    : undefined;

  const requestCount =
    typeof clickData.requestCount === 'number'
      ? clickData.requestCount
      : networkRequests ? networkRequests.length : 0;

  const parts: string[] = ['已点击元素'];
  if (requestCount > 0) {
    parts.push(`捕获到 ${requestCount} 个网络请求`);
  } else {
    parts.push('未捕获到网络请求');
  }

  return {
    ok: true,
    summary: parts.join(' | '),
    clicked: true,
    networkRequests,
    requestCount,
  };
}
