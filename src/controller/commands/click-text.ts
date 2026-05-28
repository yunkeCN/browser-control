/**
 * 文本点击命令 — click_text
 *
 * 功能: 通过文本 + 近似坐标定位元素并点击
 *
 * 策略:
 * 1. snapshot（含 boxes）→ 解析 YAML 树，筛选可见的文本匹配候选
 * 2. 按 box 中心到 (x,y) 的距离排序，选最近的
 * 3. 有 @e ref → click 命令；无 ref → CDP 坐标点击
 *
 * 失败检测:
 * - 文本无匹配 → not_found
 * - 有匹配但全部不可见（无 box）→ text_not_visible
 * - 最近匹配离坐标太远（>300px）→ 仍点击但附带偏差警告
 * - 点击失败 → 提示可能被遮挡
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import type { ClickData } from './click';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 常量 ────────────────────────────────────────────────────────

/** 超过此距离触发坐标偏差警告 */
const MAX_REASONABLE_DISTANCE_PX = 300;

// ─── 类型定义 ────────────────────────────────────────────────────

export interface ClickTextInput {
  /** 要匹配的页面文本（模糊匹配 accessible name） */
  text: string;
  /** 近似 x 坐标（用于多候选消歧义） */
  x: number;
  /** 近似 y 坐标（用于多候选消歧义） */
  y: number;
  /** 可选：限制 ARIA 角色 */
  roles?: string[];
  /** 可选：标签页 ID */
  tabId?: number;
}

export interface ClickTextData extends ClickData {
  matchedText: string;
  matchedRole: string;
  /** 点击方式: ref=click命令, cdp=CDP坐标点击 */
  method?: 'ref' | 'cdp';
  ref?: string;
  boxCenterX?: number;
  boxCenterY?: number;
  /** 选中候选到 (x,y) 的像素距离 */
  distance?: number;
  /** 可见候选总数 */
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

/**
 * 通过 CDP 在指定坐标位置执行鼠标点击
 */
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

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<ClickTextInput, ClickTextData> = {
  name: 'click_text',
  requiredArgs: ['text', 'x', 'y'],

  validate: (args: Record<string, unknown>): ClickTextInput => {
    if (typeof args.text !== 'string' || !args.text.trim()) {
      throw new Error('text 必须是有效的非空字符串');
    }
    if (typeof args.x !== 'number' || !Number.isFinite(args.x)) {
      throw new Error('x 必须是有效数字');
    }
    if (typeof args.y !== 'number' || !Number.isFinite(args.y)) {
      throw new Error('y 必须是有效数字');
    }
    return {
      text: args.text.trim(),
      x: args.x as number,
      y: args.y as number,
      roles: Array.isArray(args.roles) ? args.roles as string[] : undefined,
      tabId: typeof args.tabId === 'number' ? args.tabId : undefined,
    };
  },

  execute: async (input: ClickTextInput, daemon: DaemonClient): Promise<Record<string, unknown>> => {
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

    // 3. 无匹配
    if (allMatched.length === 0) {
      return { _status: 'not_found', _text: input.text };
    }

    // 4. 有匹配但全部不可见（都没有 box）
    if (visibleCandidates.length === 0) {
      return {
        _status: 'text_not_visible',
        _text: input.text,
        _count: allMatched.length,
        _examples: allMatched.slice(0, 3).map(c => `${c.role}:"${c.text}"`),
      };
    }

    // 5. 按距离排序，选最近的
    const scored = visibleCandidates.map(c => ({
      ...c,
      center: boxCenter(c.box!),
      dist: distance(input.x, input.y, boxCenter(c.box!).cx, boxCenter(c.box!).cy),
    }));
    scored.sort((a, b) => {
      // 同距离时优先选有 ref 的
      if (Math.abs(a.dist - b.dist) < 1) {
        if (a.ref && !b.ref) return -1;
        if (!a.ref && b.ref) return 1;
      }
      return a.dist - b.dist;
    });
    const best = scored[0];
    const { cx, cy } = best.center;

    // 6. 点击
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

    // 无 ref → CDP 坐标点击
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
  },

  toResult: (raw: Record<string, unknown>): CommandResult<ClickTextData> => {
    const status = raw._status as string;

    // 从 click 命令（ref 路径）透传的字段
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

        const riskNotes: string[] = [];
        if (distancePx > MAX_REASONABLE_DISTANCE_PX) {
          parts.push(`⚠ 最近匹配距离 ${distancePx}px，坐标可能偏差过大`);
          riskNotes.push(
            `最近匹配的 "${raw._text}" 距给定坐标 ${distancePx}px（阈值 ${MAX_REASONABLE_DISTANCE_PX}px），可能点击了非预期元素`,
          );
        }

        if (method === 'ref') {
          return {
            ok: true,
            summary: parts.join(' | '),
            baselineId,
            riskNotes: riskNotes.length ? riskNotes : undefined,
            data: {
              clicked: true,
              newTabOpened,
              network,
              matchedText: raw._text as string,
              matchedRole: raw._role as string,
              method: 'ref',
              ref: raw._ref as string,
              boxCenterX: raw._boxX as number,
              boxCenterY: raw._boxY as number,
              distance: distancePx,
              candidateCount,
            },
          };
        }
        return {
          ok: true,
          summary: parts.join(' | '),
          riskNotes: riskNotes.length ? riskNotes : undefined,
          data: {
            clicked: true,
            matchedText: raw._text as string,
            matchedRole: raw._role as string,
            method: 'cdp',
            boxCenterX: raw._boxX as number,
            boxCenterY: raw._boxY as number,
            distance: distancePx,
            candidateCount,
          },
        };
      }

      case 'click_failed':
        return {
          ok: false,
          summary: `已找到元素 "${raw._text}"（ref=${raw._ref}），但点击未生效（可能被遮挡或已移除）`,
          data: {
            clicked: false,
            newTabOpened,
            network,
            matchedText: raw._text as string,
            matchedRole: raw._role as string,
            method: 'ref',
            ref: raw._ref as string,
            boxCenterX: raw._boxX as number,
            boxCenterY: raw._boxY as number,
            distance: raw._distance as number,
            candidateCount: raw._candidateCount as number,
          },
          nextSteps: [
            `请使用 click {"target":"${raw._ref}"} 重新点击此元素`,
            '使用 snapshot 确认元素是否仍在页面上',
          ],
        };

      case 'cdp_failed':
        return {
          ok: false,
          summary: `CDP 坐标点击失败: ${raw._error || '未知错误'}`,
          data: {
            clicked: false,
            matchedText: raw._text as string,
            matchedRole: raw._role as string,
            method: 'cdp',
            boxCenterX: raw._boxX as number,
            boxCenterY: raw._boxY as number,
            distance: raw._distance as number,
            candidateCount: raw._candidateCount as number,
          },
          nextSteps: ['确认 daemon 和 extension 连接正常后重试'],
        };

      case 'text_not_visible': {
        const examples = raw._examples as string[] | undefined;
        return {
          ok: false,
          summary: `找到 ${raw._count} 个文本匹配 "${raw._text}"，但均不可见（无 box），可能需要滚动页面`,
          data: { clicked: false, matchedText: raw._text as string || '', matchedRole: '' },
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
          data: { clicked: false, matchedText: raw._text as string || '', matchedRole: '' },
          nextSteps: ['使用 snapshot 确认页面内容', '确认文本在当前页面上显示'],
        };

      case 'snapshot_failed':
        return {
          ok: false,
          summary: 'click_text 失败: 无法获取页面快照',
          data: { clicked: false, matchedText: '', matchedRole: '' },
          nextSteps: ['请确认页面已加载', '重试 click_text 命令'],
        };

      default:
        return {
          ok: false,
          summary: `click_text 失败 (${status})`,
          data: { clicked: false, matchedText: '', matchedRole: '' },
        };
    }
  },
};

/**
 * 通过文本和近似坐标查找并点击页面元素
 * - 在可见候选（有 box）中选距离 (x,y) 最近的
 * - 有 @e ref → 使用 click 命令
 * - 无 @e ref → 在 box 中心坐标使用 CDP 鼠标事件点击
 */
export async function clickText(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ClickTextData>> {
  return runCommand(def, args, client);
}
