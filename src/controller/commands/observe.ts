/**
 * 观察命令 — observe
 *
 * 功能: 建立基线观察 / 对比差异
 * 使用场景:
 *   - observe_start: 建立一个页面状态的基线快照（仅 viewport_text 模式）
 *   - observe_diff: 对比当前状态与基线的差异
 *
 * 设计要点:
 * - 参数验证使用简单的手动检查（不使用 Zod schema）
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** observe_start 命令的输入参数 */
export interface ObserveStartInput {
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 观察模式（可选，默认 viewport_text） */
  mode?: 'viewport_text';
  /** 可覆盖的基线 ID（可选，用于重新观察已有基线） */
  baselineId?: string;
}

/** observe_start 命令的输出数据 */
export interface ObserveStartData {
  /** 新生成的基线 ID */
  baselineId: string;
  /** 标签页 ID */
  tabId?: number;
  /** 基线对应的页面 URL */
  url?: string;
  /** 观察结果摘要 */
  summary: string;
}

/** observe_diff 命令的输入参数 */
export interface ObserveDiffInput {
  /** 要对比的基线 ID（必填） */
  baselineId: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 是否包含网络请求变化（可选） */
  includeNetwork?: boolean;
  /** 最多显示的新增条目数（可选） */
  maxAdded?: number;
  /** 最多显示的移除条目数（可选） */
  maxRemoved?: number;
}

/** observe_diff 命令的输出数据 */
export interface ObserveDiffData {
  /** 基线 ID */
  baselineId: string;
  /** 变化摘要 */
  summary: string;
  /** 是否有变化 */
  hasChanges: boolean;
  /** 新增文本列表 */
  addedText?: string[];
  /** 移除文本列表 */
  removedText?: string[];
  /** URL 是否发生变化 */
  urlChanged?: boolean;
}

// ─── observe_start 命令定义 ──────────────────────────────────────

const startDef: CommandDefinition<ObserveStartInput, ObserveStartData> = {
  name: 'observe_start',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): ObserveStartInput => {
    const validKeys = ['tabId', 'mode', 'baselineId'];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.mode !== undefined && args.mode !== 'viewport_text') {
      throw new Error('mode 必须是 "viewport_text"');
    }
    if (args.baselineId !== undefined && typeof args.baselineId !== 'string') {
      throw new Error('baselineId 必须是字符串');
    }
    return args as unknown as ObserveStartInput;
  },

  execute: async (
    input: ObserveStartInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'observe_start',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<ObserveStartData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData || !rawData.baselineId) {
      return {
        ok: false,
        summary: '观察失败: daemon 未返回基线 ID',
        nextSteps: ['请确认当前标签页存在', '重试 observe_start 命令'],
      };
    }

    const baselineId = String(rawData.baselineId);
    const tabId = rawData.tabId !== undefined ? Number(rawData.tabId) : undefined;
    const url = rawData.url ? String(rawData.url) : undefined;
    const observationSummary = rawData.summary ? String(rawData.summary) : `观察基线已建立: ${baselineId}`;

    return {
      ok: true,
      summary: observationSummary,
      data: {
        baselineId,
        tabId,
        url,
        summary: observationSummary,
      },
    };
  },
};

// ─── observe_diff 命令定义 ───────────────────────────────────────

const diffDef: CommandDefinition<ObserveDiffInput, ObserveDiffData> = {
  name: 'observe_diff',
  requiredArgs: ['baselineId'],

  validate: (args: Record<string, unknown>): ObserveDiffInput => {
    const validKeys = ['baselineId', 'tabId', 'includeNetwork', 'maxAdded', 'maxRemoved'];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (!args.baselineId || typeof args.baselineId !== 'string') {
      throw new Error('baselineId 是必填参数且必须是字符串');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.includeNetwork !== undefined && typeof args.includeNetwork !== 'boolean') {
      throw new Error('includeNetwork 必须是布尔值');
    }
    if (args.maxAdded !== undefined && typeof args.maxAdded !== 'number') {
      throw new Error('maxAdded 必须是数字');
    }
    if (args.maxRemoved !== undefined && typeof args.maxRemoved !== 'number') {
      throw new Error('maxRemoved 必须是数字');
    }
    return args as unknown as ObserveDiffInput;
  },

  execute: async (
    input: ObserveDiffInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'observe_diff',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<ObserveDiffData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '观察 diff 失败: daemon 未返回差异数据',
        nextSteps: ['请确认 baselineId 有效', '重试 observe_diff 命令'],
      };
    }

    const baselineId = String(rawData.baselineId || '');
    const hasChanges = Boolean(rawData.hasChanges);
    const addedText = Array.isArray(rawData.addedText)
      ? rawData.addedText.map(String)
      : undefined;
    const removedText = Array.isArray(rawData.removedText)
      ? rawData.removedText.map(String)
      : undefined;
    const urlChanged = rawData.urlChanged !== undefined ? Boolean(rawData.urlChanged) : undefined;

    const addedCount = addedText ? addedText.length : 0;
    const removedCount = removedText ? removedText.length : 0;

    const diffSummary = rawData.summary
      ? String(rawData.summary)
      : hasChanges
        ? `观察 diff: 检测到 ${addedCount + removedCount} 处变化（新增 ${addedCount} 处，移除 ${removedCount} 处）`
        : '观察 diff: 未检测到变化';

    return {
      ok: true,
      summary: diffSummary,
      data: {
        baselineId,
        summary: diffSummary,
        hasChanges,
        addedText,
        removedText,
        urlChanged,
      },
    };
  },
};

// ─── 导出命令函数 ────────────────────────────────────────────────

/**
 * 建立观察基线
 * 捕获当前页面状态作为后续对比的基准
 */
export async function observeStart(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ObserveStartData>> {
  return runCommand(startDef, args, client);
}

/**
 * 对比当前页面与基线的差异
 * 返回新增 / 移除的内容列表
 */
export async function observeDiff(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ObserveDiffData>> {
  return runCommand(diffDef, args, client);
}
