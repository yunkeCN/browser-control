/**
 * 标签页操作命令 — listTabs / findTab / closeTab
 *
 * 功能: 管理浏览器标签页
 * 使用场景: 列出所有标签页、查找特定标签页、关闭标签页
 *
 * 设计要点:
 * - 参数验证使用简单检查
 * - 协议命令使用下划线命名（list_tabs, find_tab, close_tab）
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** listTabs 命令的输入参数 */
export interface ListTabsInput {}

/** listTabs 命令的输出数据 */
export interface ListTabsData {
  tabs: Array<{ tabId: number; title: string; url: string; active: boolean }>;
  count: number;
}

/** findTab 命令的输入参数 */
export interface FindTabInput {
  /** 按 URL 模糊匹配 */
  urlIncludes?: string;
  /** 按标题模糊匹配 */
  titleIncludes?: string;
  /** 是否仅查找活跃标签页 */
  active?: boolean;
  /** 按标签页 ID 精确查找 */
  tabId?: number;
  /** 是否将找到的标签页附加为当前活跃标签页 */
  attach?: boolean;
}

/** findTab 命令的输出数据 */
export interface FindTabData {
  /** 匹配的标签页 ID */
  tabId?: number;
  /** 匹配的标签页标题 */
  title?: string;
  /** 匹配的标签页 URL */
  url?: string;
  /** 是否找到匹配的标签页 */
  found: boolean;
}

/** closeTab 命令的输入参数 */
export interface CloseTabInput {
  /** 要关闭的标签页 ID（可选，默认关闭当前标签页） */
  tabId?: number;
}

/** closeTab 命令的输出数据 */
export interface CloseTabData {
  /** 是否成功关闭 */
  closed: boolean;
  /** 已关闭的标签页 ID */
  tabId?: number;
}

// ─── listTabs 命令定义 ───────────────────────────────────────────

const listTabsDef: CommandDefinition<ListTabsInput, ListTabsData> = {
  name: 'list_tabs',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): ListTabsInput => {
    return {};
  },

  execute: async (
    input: ListTabsInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'list_tabs',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<ListTabsData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '获取标签页列表失败: daemon 未返回数据',
        nextSteps: ['请确认 daemon 正在运行', '重试 list_tabs 命令'],
      };
    }

    const tabs = (rawData.tabs as Array<Record<string, unknown>>) || [];
    const count = tabs.length;
    const activeCount = tabs.filter((t) => Boolean(t.active)).length;

    return {
      ok: true,
      summary: `标签页列表: ${count} 个标签页（${activeCount} 个活跃）`,
      data: {
        tabs: tabs.map((t) => ({
          tabId: Number(t.tabId) || 0,
          title: String(t.title || ''),
          url: String(t.url || ''),
          active: Boolean(t.active),
        })),
        count,
      },
    };
  },
};

// ─── findTab 命令定义 ─────────────────────────────────────────────

const findTabDef: CommandDefinition<FindTabInput, FindTabData> = {
  name: 'find_tab',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): FindTabInput => {
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.active !== undefined && typeof args.active !== 'boolean') {
      throw new Error('active 必须是布尔值');
    }
    if (args.attach !== undefined && typeof args.attach !== 'boolean') {
      throw new Error('attach 必须是布尔值');
    }
    if (
      args.urlIncludes !== undefined &&
      typeof args.urlIncludes !== 'string'
    ) {
      throw new Error('urlIncludes 必须是字符串');
    }
    if (
      args.titleIncludes !== undefined &&
      typeof args.titleIncludes !== 'string'
    ) {
      throw new Error('titleIncludes 必须是字符串');
    }
    return {
      tabId: args.tabId as number | undefined,
      active: args.active as boolean | undefined,
      attach: args.attach as boolean | undefined,
      urlIncludes: args.urlIncludes as string | undefined,
      titleIncludes: args.titleIncludes as string | undefined,
    };
  },

  execute: async (
    input: FindTabInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'find_tab',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<FindTabData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '查找标签页失败: daemon 未返回数据',
        nextSteps: ['请确认筛选条件正确', '重试 find_tab 命令'],
      };
    }

    const found = Boolean(rawData.found);
    if (!found) {
      return {
        ok: false,
        summary: '未找到匹配的标签页',
        nextSteps: [
          '请尝试更宽泛的搜索条件',
          '使用 list_tabs 查看所有标签页',
        ],
      };
    }

    const tabId = Number(rawData.tabId) || undefined;
    const title = String(rawData.title || '');
    const url = String(rawData.url || '');

    return {
      ok: true,
      summary: `找到标签页: "${title}"（tabId=${tabId}）`,
      data: {
        tabId,
        title,
        url,
        found: true,
      },
    };
  },
};

// ─── closeTab 命令定义 ────────────────────────────────────────────

const closeTabDef: CommandDefinition<CloseTabInput, CloseTabData> = {
  name: 'close_tab',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): CloseTabInput => {
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    return {
      tabId: args.tabId as number | undefined,
    };
  },

  execute: async (
    input: CloseTabInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'close_tab',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<CloseTabData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '关闭标签页失败: daemon 未返回结果',
        nextSteps: ['请确认标签页 ID 正确', '使用 list_tabs 查看当前标签页'],
      };
    }

    const closed = Boolean(rawData.closed);
    const tabId = Number(rawData.tabId) || 0;

    if (!closed) {
      return {
        ok: false,
        summary: `关闭标签页失败: tabId=${tabId}`,
        nextSteps: ['该标签页可能已被关闭', '使用 list_tabs 查看当前标签页'],
      };
    }

    return {
      ok: true,
      summary: `已关闭标签页 tabId=${tabId}`,
      data: {
        closed: true,
        tabId,
      },
    };
  },
};

// ─── 导出函数 ──────────────────────────────────────────────────────

/**
 * 获取所有标签页列表（可通过 CommandRunner 直接调用）
 */
export async function listTabs(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ListTabsData>> {
  return runCommand(listTabsDef, args, client);
}

/**
 * 查找指定标签页（可通过 CommandRunner 直接调用）
 */
export async function findTab(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<FindTabData>> {
  return runCommand(findTabDef, args, client);
}

/**
 * 关闭指定标签页（可通过 CommandRunner 直接调用）
 */
export async function closeTab(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<CloseTabData>> {
  return runCommand(closeTabDef, args, client);
}
