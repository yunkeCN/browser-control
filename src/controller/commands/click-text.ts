/**
 * 文本定位点击 — 内部实现
 *
 * 通过文本 + 近似坐标定位元素并点击。
 * 由统一 click 命令的 text 模式调用。
 *
 * 策略:
 * 1. snapshot（含 boxes）→ 解析 YAML 树，筛选可见的文本匹配候选
 * 2. 按 box 中心到 (x,y) 的距离排序，选最近的
 * 3. 有 @e ref → click 命令；无 ref → CDP 坐标点击
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import type { ClickData } from './click';

// ─── 常量 ────────────────────────────────────────────────────────

const MAX_REASONABLE_DISTANCE_PX = 300;

// ─── 类型定义 ────────────────────────────────────────────────────

export interface ClickTextInput {
  text: string;
  x: number;
  y: number;
  roles?: string[];
  tabId?: number;
}

export interface ClickTextData extends ClickData {
  matchedText: string;
  matchedRole: string;
  method?: 'ref' | 'cdp';
  ref?: string;
  boxCenterX?: number;
  boxCenterY?: number;
  distance?: number;
  candidateCount?: number;
}

// ─── 解析辅助 ────────────────────────────────────────────────────

interface Candidate {
  role: string;
  text: string;
  ref: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
}

function extractBox(line: string): { x: number; y: number; width: number; height: number } | null {
  const m = line.match(/\[box=(\d+),(\d+),(\d+),(\d+)\]/);
  return m ? { x: +m[1], y: +m[2], width: +m[3], height: +m[4] } : null;
}

function extractRef(line: string): string | null {
  const m = line.match(/\[ref=(@e[a-z0-9]+_[0-9]+)\]/);
  return m ? m[1] : null;
}

function extractRole(line: string): string | null {
  const m = line.trim().match(/^- (\w+)/);
  return m ? m[1] : null;
}

function extractText(line: string): string | null {
  const start = line.indexOf('"');
  if (start === -1) return null;
  const end = line.indexOf('"', start + 1);
  if (end === -1) return null;
  return line.slice(start + 1, end);
}

function boxCenter(box: { x: number; y: number; width: number; height: number }): { cx: number; cy: number } {
  return {
    cx: Math.round(box.x + box.width / 2),
    cy: Math.round(box.y + box.height / 2),
  };
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

async function cdpClickAt(
  x: number,
  y: number,
  daemon: DaemonClient,
  tabId?: number,
): Promise<{ clicked: boolean; error?: string }> {
  try {
    const envelope = daemon.buildEnvelope('cdp_click_at', { x, y, tabId });
    const response = await daemon.command(envelope);
    const respData = response.data as Record<string, unknown> | undefined;
    if (respData?.ok === false) {
      const errMsg = (respData.error as Record<string, unknown> | undefined)?.message as string || 'CDP click failed';
      return { clicked: false, error: errMsg };
    }
    const clickData = respData?.data as Record<string, unknown> | undefined;
    return { clicked: clickData?.clicked === true };
  } catch (err: unknown) {
    return {
      clicked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── 执行函数 ────────────────────────────────────────────────────

export async function executeClickText(
  input: ClickTextInput,
  daemon: DaemonClient,
): Promise<Record<string, unknown>> {
  // 1. 获取 snapshot（含 boxes，全页面）
  const snapResp = await daemon.command(daemon.buildEnvelope('snapshot', {
    viewportOnly: false,
    boxes: true,
    tabId: input.tabId,
  }));
  const envelope = snapResp.data as Record<string, unknown>;
  const snapData = envelope.data as Record<string, unknown> | undefined;
  const snapText = snapData?.snapshot as string | undefined;

  if (!snapText) {
    return { _status: 'snapshot_failed' };
  }

  // 2. 解析 YAML 树，筛选可见候选（必须有 box）
  const lines = snapText.split('\n');
  const visibleCandidates: Candidate[] = [];
  const allMatched: Candidate[] = [];

  for (const line of lines) {
    const role = extractRole(line);
    const text = extractText(line);
    if (!role || !text) continue;
    if (!text.toLowerCase().includes(input.text.toLowerCase())) continue;
    if (input.roles && !input.roles.includes(role)) continue;

    const candidate: Candidate = {
      role,
      text,
      ref: extractRef(line),
      box: extractBox(line),
    };
    allMatched.push(candidate);
    if (candidate.box) {
      visibleCandidates.push(candidate);
    }
  }

  if (allMatched.length === 0) {
    return { _status: 'not_found', _text: input.text };
  }

  if (visibleCandidates.length === 0) {
    return {
      _status: 'text_not_visible',
      _text: input.text,
      _count: allMatched.length,
      _examples: allMatched.slice(0, 3).map(c => `${c.role}:"${c.text}"`),
    };
  }

  // 3. 按距离排序
  const scored = visibleCandidates.map(c => ({
    ...c,
    center: boxCenter(c.box!),
    dist: distance(input.x, input.y, boxCenter(c.box!).cx, boxCenter(c.box!).cy),
  }));
  scored.sort((a, b) => {
    if (Math.abs(a.dist - b.dist) < 1) {
      if (a.ref && !b.ref) return -1;
      if (!a.ref && b.ref) return 1;
    }
    return a.dist - b.dist;
  });
  const best = scored[0];
  const { cx, cy } = best.center;

  // 4. 点击
  if (best.ref) {
    const clickResp = await daemon.command(daemon.buildEnvelope('click', {
      target: best.ref,
      tabId: input.tabId,
    }));
    const clickEnv = clickResp.data as Record<string, unknown>;
    const clickData = clickEnv.data as Record<string, unknown> | undefined;
    const clicked = clickData?.clicked === true;
    const newTabOpened = Boolean(clickData?.newTabOpened);
    const network = clickData?.network as { requests?: string[]; count?: number } | undefined;
    const changes = clickData?.changes as Record<string, unknown> | undefined;
    const clickBaselineId = typeof changes?.baselineId === 'string' ? changes.baselineId : undefined;

    return {
      _status: clicked ? 'clicked' : 'click_failed',
      _method: 'ref',
      _ref: best.ref,
      _text: best.text,
      _role: best.role,
      _clicked: clicked,
      _distance: Math.round(best.dist),
      _candidateCount: visibleCandidates.length,
      _boxX: cx,
      _boxY: cy,
      _newTabOpened: newTabOpened,
      _network: network,
      _baselineId: clickBaselineId,
    };
  }

  const result = await cdpClickAt(cx, cy, daemon, input.tabId);
  return {
    _status: result.clicked ? 'clicked' : 'cdp_failed',
    _method: 'cdp',
    _text: best.text,
    _role: best.role,
    _clicked: result.clicked,
    _distance: Math.round(best.dist),
    _candidateCount: visibleCandidates.length,
    _boxX: cx,
    _boxY: cy,
    _error: result.error,
  };
}

export function toClickTextResult(raw: Record<string, unknown>): CommandResult<ClickTextData> {
  const status = raw._status as string;
  const newTabOpened = raw._newTabOpened as boolean | undefined;
  const network = raw._network as { requests: string[]; count: number } | undefined;
  const baselineId = raw._baselineId as string | undefined;

  switch (status) {
    case 'clicked': {
      const method = raw._method as 'ref' | 'cdp';
      const distancePx = raw._distance as number;
      const candidateCount = raw._candidateCount as number;
      const parts: string[] = [];

      if (method === 'ref') {
        parts.push(`已点击距离 (${raw._boxX}, ${raw._boxY}) 最近的 "${raw._text}"（${raw._role}）`);
      } else {
        parts.push(`已点击坐标 (${raw._boxX}, ${raw._boxY}) 处的 "${raw._text}"（${raw._role}）`);
      }
      parts.push(`距离 ${distancePx}px，共 ${candidateCount} 个候选`);
      if (network) {
        parts.push(`触发 ${network.count || network.requests?.length || 0} 个接口请求`);
      }

      if (distancePx > MAX_REASONABLE_DISTANCE_PX) {
        parts.push(`最近匹配距离 ${distancePx}px，坐标可能偏差过大`);
      }

      if (method === 'ref') {
        return {
          ok: true,
          summary: parts.join(' | '),
          baselineId,
          clicked: true,
          newTabOpened,
          network,
          matchedText: raw._text as string,
          matchedRole: raw._role as string,
          method: 'ref' as const,
          ref: raw._ref as string,
          boxCenterX: raw._boxX as number,
          boxCenterY: raw._boxY as number,
          distance: distancePx,
          candidateCount,
        };
      }
      return {
        ok: true,
        summary: parts.join(' | '),
        clicked: true,
        matchedText: raw._text as string,
        matchedRole: raw._role as string,
        method: 'cdp' as const,
        boxCenterX: raw._boxX as number,
        boxCenterY: raw._boxY as number,
        distance: distancePx,
        candidateCount,
      };
    }

    case 'click_failed':
      return {
        ok: false,
        summary: `已找到元素 "${raw._text}"（ref=${raw._ref}），但点击未生效（可能被遮挡或已移除）`,
        clicked: false,
        newTabOpened,
        network,
        matchedText: raw._text as string,
        matchedRole: raw._role as string,
        method: 'ref' as const,
        ref: raw._ref as string,
        boxCenterX: raw._boxX as number,
        boxCenterY: raw._boxY as number,
        distance: raw._distance as number,
        candidateCount: raw._candidateCount as number,
        nextSteps: [
          '使用 snapshot 确认元素是否仍在页面上',
        ],
      };

    case 'cdp_failed':
      return {
        ok: false,
        summary: `CDP 坐标点击失败: ${raw._error || '未知错误'}`,
        clicked: false,
        matchedText: raw._text as string,
        matchedRole: raw._role as string,
        method: 'cdp' as const,
        boxCenterX: raw._boxX as number,
        boxCenterY: raw._boxY as number,
        distance: raw._distance as number,
        candidateCount: raw._candidateCount as number,
        nextSteps: ['确认 daemon 和 extension 连接正常后重试'],
      };

    case 'text_not_visible': {
      const examples = raw._examples as string[] | undefined;
      return {
        ok: false,
        summary: `找到 ${raw._count} 个文本匹配 "${raw._text}"，但均不可见（无 box），可能需要滚动页面`,
        clicked: false, matchedText: raw._text as string || '', matchedRole: '',
        nextSteps: [
          '使用 scroll 滚动页面后重试',
          examples?.length ? `匹配到的不可见元素: ${examples.join(', ')}` : '',
        ].filter(Boolean),
      };
    }

    case 'not_found':
      return {
        ok: false,
        summary: `未找到包含「${raw._text}」的页面元素`,
        clicked: false, matchedText: raw._text as string || '', matchedRole: '',
        nextSteps: ['使用 snapshot 确认页面内容', '确认文本在当前页面上显示'],
      };

    case 'snapshot_failed':
      return {
        ok: false,
        summary: '文本定位点击失败: 无法获取页面快照',
        clicked: false, matchedText: '', matchedRole: '',
        nextSteps: ['请确认页面已加载', '重试 click 命令'],
      };

    default:
      return {
        ok: false,
        summary: `文本定位点击失败 (${status})`,
        clicked: false, matchedText: '', matchedRole: '',
      };
  }
}
