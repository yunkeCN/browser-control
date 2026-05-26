/**
 * 文本点击命令 — click_text
 *
 * 功能: 通过页面文本内容定位元素并使用 CDP 在坐标位置点击
 *
 * 策略:
 * 1. snapshot（含 boxes）→ 解析 YAML 树匹配目标文本
 * 2. 计算 box 中心坐标 → 调用 cdp_click_at 命令在坐标处点击
 * 3. CDP Input.dispatchMouseEvent 绕过 CSP，最可靠
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

export interface ClickTextInput {
  /** 要匹配的页面文本（模糊匹配 accessible name） */
  text: string;
  /** 可选：限制 ARIA 角色 */
  roles?: string[];
  /** 可选：多个匹配时的索引 */
  index?: number;
  /** 可选：标签页 ID */
  tabId?: number;
}

export interface ClickTextData {
  clicked: boolean;
  matchedText: string;
  matchedRole: string;
  /** 点击方式: ref=click命令, cdp=CDP坐标点击 */
  method?: 'ref' | 'cdp';
  ref?: string;
  boxCenterX?: number;
  boxCenterY?: number;
  allCandidates?: string[];
}

// ─── 解析辅助 ────────────────────────────────────────────────────

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

/**
 * 通过 CDP 在指定坐标位置执行鼠标点击
 * 使用 chrome.debugger.sendCommand('Input.dispatchMouseEvent')
 * 绕过 CSP，最可靠
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
  requiredArgs: ['text'],

  validate: (args: Record<string, unknown>): ClickTextInput => {
    if (typeof args.text !== 'string' || !args.text.trim()) {
      throw new Error('text 必须是有效的非空字符串');
    }
    return {
      text: args.text.trim(),
      roles: Array.isArray(args.roles) ? args.roles as string[] : undefined,
      index: typeof args.index === 'number' ? args.index : undefined,
      tabId: typeof args.tabId === 'number' ? args.tabId : undefined,
    };
  },

  execute: async (input: ClickTextInput, daemon: DaemonClient): Promise<Record<string, unknown>> => {
    // 1. 获取 snapshot
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

    // 2. 解析 YAML 树匹配目标文本
    const lines = snapText.split('\n');
    const candidates: Array<{
      role: string; text: string; ref: string | null;
      box: ReturnType<typeof extractBox>;
    }> = [];

    for (const line of lines) {
      const role = extractRole(line);
      const text = extractText(line);
      if (!role || !text) continue;
      if (!text.toLowerCase().includes(input.text.toLowerCase())) continue;
      if (input.roles && !input.roles.includes(role)) continue;
      candidates.push({ role, text, ref: extractRef(line), box: extractBox(line) });
    }

    if (candidates.length === 0) {
      return { _status: 'not_found', _text: input.text };
    }

    const idx = input.index ?? 0;
    const target = candidates[idx];
    if (!target) {
      return {
        _status: 'index_out_of_range',
        _text: input.text,
        _all: candidates.map(c => `${c.role}:"${c.text}"`),
        _count: candidates.length,
        _index: idx,
      };
    }

    // 3. 有 @e ref → 使用 click 命令
    if (target.ref) {
      const clickResp = await daemon.command(daemon.buildEnvelope('click', {
        target: target.ref,
        tabId: input.tabId,
        after: 'none',
      }));
      const clickEnv = clickResp.data as Record<string, unknown>;
      const clickData = clickEnv.data as Record<string, unknown> | undefined;
      const clicked = clickData?.clicked === true;

      return {
        _status: clicked ? 'clicked' : 'click_failed',
        _method: 'ref',
        _ref: target.ref,
        _text: target.text,
        _role: target.role,
        _clicked: clicked,
      };
    }

    // 4. 无 @e ref → 使用 CDP 坐标点击
    if (target.box) {
      const cx = Math.round(target.box.x + target.box.width / 2);
      const cy = Math.round(target.box.y + target.box.height / 2);
      const result = await cdpClickAt(cx, cy, daemon, input.tabId);

      return {
        _status: result.clicked ? 'clicked' : 'cdp_failed',
        _method: 'cdp',
        _text: target.text,
        _role: target.role,
        _clicked: result.clicked,
        _boxX: cx,
        _boxY: cy,
        _error: result.error,
      };
    }

    return { _status: 'found_no_box', _text: target.text, _role: target.role };
  },

  toResult: (raw: Record<string, unknown>): CommandResult<ClickTextData> => {
    const status = raw._status as string;

    switch (status) {
      case 'clicked': {
        const method = raw._method as 'ref' | 'cdp';
        if (method === 'ref') {
          return {
            ok: true,
            summary: `已点击元素 "${raw._text}"（${raw._role}）`,
            data: {
              clicked: true, matchedText: raw._text as string,
              matchedRole: raw._role as string, method: 'ref',
              ref: raw._ref as string,
            },
          };
        }
        return {
          ok: true,
          summary: `已点击坐标 (${raw._boxX}, ${raw._boxY}) 处的 "${raw._text}"`,
          data: {
            clicked: true, matchedText: raw._text as string,
            matchedRole: raw._role as string, method: 'cdp',
            boxCenterX: raw._boxX as number, boxCenterY: raw._boxY as number,
          },
        };
      }

      case 'click_failed':
        return {
          ok: false,
          summary: `已找到元素 "${raw._text}"（ref=${raw._ref}），但点击未生效`,
          data: { clicked: false, matchedText: raw._text as string, matchedRole: raw._role as string, method: 'ref', ref: raw._ref as string },
          nextSteps: [`请使用 click {"target":"${raw._ref}"} 重新点击此元素`],
        };

      case 'cdp_failed':
        return {
          ok: false,
          summary: `CDP 坐标点击失败: ${raw._error || '未知错误'}`,
          data: {
            clicked: false, matchedText: raw._text as string,
            matchedRole: raw._role as string, method: 'cdp',
            boxCenterX: raw._boxX as number, boxCenterY: raw._boxY as number,
          },
          nextSteps: ['确认 daemon 和 extension 连接正常后重试'],
        };

      case 'not_found':
        return {
          ok: false,
          summary: `未找到包含「${raw._text}」的页面元素`,
          data: { clicked: false, matchedText: raw._text as string || '', matchedRole: '' },
          nextSteps: ['使用 snapshot 确认页面内容', '确认文本在当前页面上显示'],
        };

      case 'index_out_of_range':
        return {
          ok: false,
          summary: `找到 ${raw._count} 个匹配，但索引 ${raw._index} 超出范围`,
          data: { clicked: false, matchedText: '', matchedRole: '', allCandidates: raw._all as string[] },
          nextSteps: [`可用候选: ${(raw._all as string[]).join(', ')}`],
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
 * 通过文本查找并点击页面元素
 * - 有 @e ref → 使用 click 命令
 * - 无 @e ref → 在 box 中心坐标使用 CDP 鼠标事件点击（绕过 CSP）
 */
export async function clickText(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ClickTextData>> {
  return runCommand(def, args, client);
}
