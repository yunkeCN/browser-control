/**
 * 页面快照命令 — snapshot
 *
 * 功能: 获取当前页面的可访问性快照
 * 输出: YAML 树格式字符串 (data.tree)，展示页面层级结构
 *
 * 支持 baseline 参数对比模式：
 *   第一次调用 snapshot baseline=<id> 时存储基线
 *   第二次调用 snapshot baseline=<id> 时返回 DOM 结构语义级 diff
 *
 * 输出格式参考 Playwright MCP:
 *   - button "Search" [ref=e42] [cursor=pointer]
 *   - textbox "Search" [ref=e44]: query
 *   - heading "Results" [level=2] [ref=e50]
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import type { SnapshotNode } from '../../../contracts';
import { runCommand, type CommandDefinition } from '../runner';
import { computeSnapshotDiff, type StructureDiff } from './snapshot-diff';
import { setBaseline, getBaseline, hasBaseline } from './shared-baseline';

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
  /**
   * 基线 ID（可选）
   * 首次调用时存储当前快照；再次调用同一 baseline 时返回结构差异
   */
  baseline?: string;
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
  /** 基线 ID（仅 baseline 模式返回） */
  baselineId?: string;
  /** 结构差异（仅 baseline 对比模式返回） */
  diff?: StructureDiff;
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

// ─── 基线存储（使用共享存储，供 click 等命令共用） ──────────────

const def: CommandDefinition<SnapshotInput, SnapshotData> = {
  name: 'snapshot',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): SnapshotInput => {
    const validKeys = [
      'tabId', 'roles', 'tags', 'hasVisibleText',
      'textIncludes', 'viewportOnly', 'boxes', 'baseline',
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
    if (args.baseline !== undefined && typeof args.baseline !== 'string') {
      throw new Error('baseline 必须是字符串');
    }
    return args as unknown as SnapshotInput;
  },

  execute: async (
    input: SnapshotInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    // 分离 baseline 参数（不发送到 daemon）
    const { baseline, ...snapshotArgs } = input;
    // viewportOnly 默认 false: 确保 Drawer/Modal 内元素被捕获
    // boxes 默认 true: 确保元素位置信息可用于 click_text 等命令
    const effectiveArgs = {
      ...snapshotArgs,
      viewportOnly: snapshotArgs.viewportOnly ?? false,
      boxes: snapshotArgs.boxes ?? true,
    } as unknown as Record<string, unknown>;
    const envelope = daemon.buildEnvelope(
      'snapshot',
      effectiveArgs,
    );
    const response = await daemon.command(envelope);
    // response.data = { ok: true, data: { snapshot, tree, refs, ... } }
    const daemonBody = response.data as Record<string, unknown> || {};
    const snapshotData = daemonBody.data as Record<string, unknown> | undefined;
    if (baseline && snapshotData) {
      // 注入 baseline 到内部 data，使 toResult 能获取
      snapshotData._baseline = baseline;
      // 深拷贝 tree 用于后续 diff 计算
      const rawTree = snapshotData.tree as SnapshotNode[] | undefined;
      if (rawTree) {
        snapshotData._treeCapture = JSON.parse(JSON.stringify(rawTree));
      }
    }
    return daemonBody;
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

    const title = String(snapshotData.title || '');
    const url = String(snapshotData.url || '');
    const tree = extractTree(snapshotData);
    const elementCount = countElements(snapshotData);

    // baseline 模式（通过 execute 注入到 raw）
    const baseline = snapshotData._baseline as string | undefined;
    const rawTree = snapshotData._treeCapture as Array<SnapshotNode | { text: string }> | undefined;
    if (baseline) {
      if (!hasBaseline(baseline)) {
        // 首次调用: 存储快照作为基线
        if (rawTree) {
          setBaseline(baseline, rawTree);
        }
        return {
          ok: true,
          summary: `基线已建立: ${baseline}（${elementCount} 个交互元素）`,
          data: {
            title,
            url,
            tree,
            elementCount,
            baselineId: baseline,
          },
        };
      }

      // 第二次调用: 计算差异
      const baselineTree = getBaseline(baseline)!;
      const currentTree = rawTree || [];
      const diff = computeSnapshotDiff(baselineTree, currentTree);

      // 更新基线为当前快照（后续调用继续对比最新）
      if (rawTree) {
        setBaseline(baseline, rawTree);
      }

      return {
        ok: true,
        summary: `基线对比 ${baseline}: ${diff.summary}`,
        data: {
          title,
          url,
          tree,
          elementCount,
          baselineId: baseline,
          diff,
        },
      };
    }

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
