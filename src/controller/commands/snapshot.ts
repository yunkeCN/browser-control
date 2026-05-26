/**
 * 页面快照命令 — snapshot
 *
 * 功能: 获取当前页面的可访问性快照
 * 输出: YAML 树格式字符串 (data.tree)，展示页面层级结构
 *
 * 输出格式参考 Playwright MCP:
 *   - button "Search" [ref=e42] [cursor=pointer]
 *   - textbox "Search" [ref=e44]: query
 *   - heading "Results" [level=2] [ref=e50]
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** snapshot 命令的输入参数 */
export interface SnapshotInput {
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 只返回指定的 ARIA 角色，如 ["button", "link", "textbox"] */
  roles?: string[];
  /** 只返回指定的 HTML 标签 */
  tags?: string[];
  /** 只返回包含可见文本的节点 */
  hasVisibleText?: boolean;
  /** 按可见文本模糊匹配元素 */
  textIncludes?: string;
  /** 是否只返回视口内的元素 */
  viewportOnly?: boolean;
  /** 是否包含元素位置信息 [box=x,y,w,h] */
  boxes?: boolean;
}

/** snapshot 命令的输出数据 */
export interface SnapshotData {
  /** 页面标题 */
  title: string;
  /** 页面 URL */
  url: string;
  /**
   * 页面可访问性树（YAML 格式字符串）
   *
   * 格式: 每个节点一行，缩进表示层级
   *   - role "accessible name" [ref=e<id>] [attr=val]: value
   *
   * 示例:
   *   - textbox "搜索" [ref=e44]
   *   - button "Google 搜索" [ref=e45] [cursor=pointer]
   *   - navigation "main" [ref=e46]:
   *     - link "Gmail" [ref=e47]
   *     - link "图片" [ref=e48]
   */
  tree: string;
  /** 页面中可交互元素的总数（对应 @e 引用的数量） */
  elementCount: number;
}

// ─── 辅助函数 ────────────────────────────────────────────────────

/**
 * 从 daemon 返回的原始数据中提取 YAML 树文本
 * - 优先使用 data.snapshot（已有的 YAML 格式）
 * - 如果快照被截断，仍返回可用的预览部分
 */
function extractTree(raw: Record<string, unknown>): string {
  const snapshot = raw.snapshot;
  if (typeof snapshot === 'string' && snapshot.length > 0) {
    return snapshot;
  }
  return '';
}

/**
 * 统计可交互元素数量
 * 优先使用 refs 数组长度，否则使用 stats 中的信息
 */
function countElements(raw: Record<string, unknown>): number {
  const refs = raw.refs;
  if (Array.isArray(refs)) {
    return refs.length;
  }
  const stats = raw.stats;
  if (stats && typeof stats === 'object') {
    const s = stats as Record<string, unknown>;
    if (typeof s.emitted === 'number') return s.emitted;
  }
  return 0;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<SnapshotInput, SnapshotData> = {
  name: 'snapshot',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): SnapshotInput => {
    const validKeys = [
      'tabId', 'roles', 'tags', 'hasVisibleText',
      'textIncludes', 'viewportOnly', 'boxes',
    ];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (
      args.roles !== undefined &&
      (!Array.isArray(args.roles) || !args.roles.every((r) => typeof r === 'string'))
    ) {
      throw new Error('roles 必须是字符串数组');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    return args as unknown as SnapshotInput;
  },

  execute: async (
    input: SnapshotInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    // viewportOnly 默认 false: 确保 Drawer/Modal 内元素被捕获
    // boxes 默认 true: 确保元素位置信息可用于 click_text 等命令
    const effectiveArgs = {
      ...input,
      viewportOnly: input.viewportOnly ?? false,
      boxes: input.boxes ?? true,
    } as unknown as Record<string, unknown>;
    const envelope = daemon.buildEnvelope(
      'snapshot',
      effectiveArgs,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<SnapshotData> => {
    const snapshotData = raw.data as Record<string, unknown> | undefined;

    if (!snapshotData) {
      return {
        ok: false,
        summary: '快照失败: daemon 未返回快照数据',
        nextSteps: ['请确认当前标签页存在', '重试 snapshot 命令'],
      };
    }

    const tree = extractTree(snapshotData);
    const elementCount = countElements(snapshotData);
    const title = String(snapshotData.title || '');
    const url = String(snapshotData.url || '');

    return {
      ok: true,
      summary: `页面${title ? `「${title}」` : ''}快照: ${elementCount} 个交互元素`,
      data: {
        title,
        url,
        tree,
        elementCount,
      },
    };
  },
};

/**
 * 获取当前页面的可访问性快照
 */
export async function snapshot(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<SnapshotData>> {
  return runCommand(def, args, client);
}
