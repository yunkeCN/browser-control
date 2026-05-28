/**
 * 统一标签页命令 — tabs
 *
 * 三种操作:
 * - action: 'list' (默认) — 列出所有标签页
 * - action: 'switch' — 按条件查找并切换到匹配的标签页
 * - action: 'close' — 关闭标签页
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

export type TabsAction = 'list' | 'switch' | 'close';

export interface TabsInput {
  action?: TabsAction;
  // switch 参数
  urlIncludes?: string;
  titleIncludes?: string;
  active?: boolean;
  tabId?: number;
}

export interface ListTabsData {
  tabs: Array<{ tabId: number; title: string; url: string; active: boolean }>;
  count: number;
}

export interface SwitchTabData {
  tabId?: number;
  title?: string;
  url?: string;
  found: boolean;
}

export interface CloseTabData {
  closed: boolean;
  tabId?: number;
}

export type TabsData = ListTabsData | SwitchTabData | CloseTabData;

// ─── 命令定义 ────────────────────────────────────────────────────

const tabsDef: CommandDefinition<TabsInput, TabsData> = {
  name: 'tabs',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): TabsInput => {
    const action = (args.action as string | undefined) || 'list';
    if (!['list', 'switch', 'close'].includes(action)) {
      throw new Error('action 必须是 "list"、"switch" 或 "close"');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.active !== undefined && typeof args.active !== 'boolean') {
      throw new Error('active 必须是布尔值');
    }
    if (args.urlIncludes !== undefined && typeof args.urlIncludes !== 'string') {
      throw new Error('urlIncludes 必须是字符串');
    }
    if (args.titleIncludes !== undefined && typeof args.titleIncludes !== 'string') {
      throw new Error('titleIncludes 必须是字符串');
    }
    return {
      action: action as TabsAction,
      tabId: args.tabId as number | undefined,
      urlIncludes: args.urlIncludes as string | undefined,
      titleIncludes: args.titleIncludes as string | undefined,
      active: args.active as boolean | undefined,
    };
  },

  execute: async (
    input: TabsInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const action = input.action || 'list';

    switch (action) {
      case 'list': {
        const envelope = daemon.buildEnvelope('list_tabs', {});
        const response = await daemon.command(envelope);
        return { ...response.data as Record<string, unknown>, _action: 'list' };
      }
      case 'switch': {
        const envelope = daemon.buildEnvelope('find_tab', {
          urlIncludes: input.urlIncludes,
          titleIncludes: input.titleIncludes,
          active: input.active,
          tabId: input.tabId,
          attach: true,
        });
        const response = await daemon.command(envelope);
        return { ...response.data as Record<string, unknown>, _action: 'switch' };
      }
      case 'close': {
        const envelope = daemon.buildEnvelope('close_tab', {
          tabId: input.tabId,
        });
        const response = await daemon.command(envelope);
        return { ...response.data as Record<string, unknown>, _action: 'close' };
      }
    }
  },

  toResult: (raw: Record<string, unknown>): CommandResult<TabsData> => {
    const action = raw._action as string;
    const rawData = raw.data as Record<string, unknown> | undefined;

    switch (action) {
      case 'list': {
        if (!rawData) {
          return {
            ok: false,
            summary: '获取标签页列表失败: daemon 未返回数据',
            nextSteps: ['请确认 daemon 正在运行'],
          };
        }
        const tabs = (rawData.tabs as Array<Record<string, unknown>>) || [];
        const count = tabs.length;
        const activeCount = tabs.filter((t) => Boolean(t.active)).length;
        return {
          ok: true,
          summary: `标签页列表: ${count} 个标签页（${activeCount} 个活跃）`,
          tabs: tabs.map((t) => ({
            tabId: Number(t.tabId) || 0,
            title: String(t.title || ''),
            url: String(t.url || ''),
            active: Boolean(t.active),
          })),
          count,
        };
      }

      case 'switch': {
        if (!rawData) {
          return {
            ok: false,
            summary: '切换标签页失败: daemon 未返回数据',
            nextSteps: ['请确认筛选条件正确', '使用 tabs 查看所有标签页'],
          };
        }
        const found = Boolean(rawData.found);
        if (!found) {
          return {
            ok: false,
            summary: '未找到匹配的标签页',
            nextSteps: ['请尝试更宽泛的搜索条件', '使用 tabs 查看所有标签页'],
          };
        }
        const tabId = Number(rawData.tabId) || undefined;
        const title = String(rawData.title || '');
        const url = String(rawData.url || '');
        return {
          ok: true,
          summary: `已切换到标签页: "${title}"（tabId=${tabId}）`,
          tabId, title, url, found: true as const,
        };
      }

      case 'close': {
        if (!rawData) {
          return {
            ok: false,
            summary: '关闭标签页失败: daemon 未返回结果',
            nextSteps: ['请确认标签页 ID 正确', '使用 tabs 查看当前标签页'],
          };
        }
        const closed = Boolean(rawData.closed);
        const tabId = Number(rawData.tabId) || 0;
        if (!closed) {
          return {
            ok: false,
            summary: `关闭标签页失败: tabId=${tabId}`,
            nextSteps: ['该标签页可能已被关闭', '使用 tabs 查看当前标签页'],
          };
        }
        return {
          ok: true,
          summary: `已关闭标签页 tabId=${tabId}`,
          closed: true as const, tabId,
        };
      }

      default:
        return { ok: false, summary: `未知操作: ${action}` };
    }
  },
};

// ─── 导出 ────────────────────────────────────────────────────────

export async function tabs(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<TabsData>> {
  return runCommand(tabsDef, args, client);
}
