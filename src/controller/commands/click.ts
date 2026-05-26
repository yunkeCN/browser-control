/**
 * 点击命令 — click
 *
 * 功能: 点击页面上的指定元素
 * 使用场景: 点击按钮、链接、输入框等可交互元素
 *
 * 设计要点:
 * - 参数验证使用简单检查（非 Zod schema）
 * - target 必须是 @e<structureId>_<revision> 引用或 css=<selector> 选择器
 * - 支持 after 参数控制点击后的观察行为
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** click 命令的输入参数 */
export interface ClickInput {
  /** 目标元素引用（@e 引用或 css= 选择器） */
  target: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 点击后的观察模式（可选，默认 auto） */
  after?: 'auto' | 'none' | 'changes' | 'snapshot';
}

/** click 命令的输出数据 */
export interface ClickData {
  /** 是否成功点击 */
  clicked: boolean;
  /** 页面变化摘要（after=auto / changes 时提供） */
  changeSummary?: string;
  /** 是否打开了新标签页 */
  newTabOpened?: boolean;
  /** 点击后快照（after=snapshot 时提供） */
  postSnapshot?: { tree: string; elementCount: number };
}

// ─── 辅助函数 ────────────────────────────────────────────────────

/** @e 引用正则: @e<structureId>_<revision> */
const ELEMENT_REF_RE = /^@e[^\s_]+_\d+$/;

/** CSS 选择器前缀 */
const CSS_PREFIX = 'css=';

/** after 参数的允许值 */
const AFTER_VALUES = ['auto', 'none', 'changes', 'snapshot'] as const;

/**
 * 验证 target 是否有效
 * - @e<structureId>_<revision> 格式（来自快照的引用）
 * - css=<selector> 格式（显式 CSS 选择器）
 */
function isValidTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0) return false;
  return ELEMENT_REF_RE.test(target) || target.startsWith(CSS_PREFIX);
}

/**
 * 从 postSnapshot 原始数据中提取 YAML 树
 */
function extractPostSnapshotTree(raw: Record<string, unknown>): string {
  const snapshot = raw.snapshot;
  if (typeof snapshot === 'string' && snapshot.length > 0) {
    return snapshot;
  }
  return '';
}

/**
 * 从 postSnapshot 原始数据中统计元素数量
 */
function countPostSnapshotElements(raw: Record<string, unknown>): number {
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

const def: CommandDefinition<ClickInput, ClickData> = {
  name: 'click',
  requiredArgs: ['target'],

  /**
   * 参数验证
   * 使用简单检查确保 target 格式正确
   */
  validate: (args: Record<string, unknown>): ClickInput => {
    if (!isValidTarget(args.target)) {
      throw new Error(
        'target 必须是 @e<structureId>_<revision> 引用或 css=<selector> 选择器',
      );
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (
      args.after !== undefined &&
      !(AFTER_VALUES as readonly string[]).includes(args.after as string)
    ) {
      throw new Error('after 必须是 auto / none / changes / snapshot 之一');
    }
    return {
      target: args.target as string,
      tabId: args.tabId as number | undefined,
      after: args.after as 'auto' | 'none' | 'changes' | 'snapshot' | undefined,
    };
  },

  /**
   * 执行点击
   * 通过 DaemonClient 向 daemon 发送 click 命令
   */
  execute: async (
    input: ClickInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'click',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取 daemon 返回的业务数据（clicked, changes, postSnapshot）
   * - 生成包含点击结果和页面变化的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<ClickData> => {
    const clickData = raw.data as Record<string, unknown> | undefined;

    if (!clickData) {
      return {
        ok: false,
        summary: '点击失败: daemon 未返回点击结果',
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

    // 提取变化摘要
    const changes = clickData.changes as Record<string, unknown> | undefined;
    const changeSummary = changes?.summary as string | undefined;

    // 提取 postSnapshot
    const rawPostSnapshot = clickData.postSnapshot as
      | Record<string, unknown>
      | undefined;
    let postSnapshot: { tree: string; elementCount: number } | undefined;
    if (rawPostSnapshot) {
      const tree = extractPostSnapshotTree(rawPostSnapshot);
      const elementCount = countPostSnapshotElements(rawPostSnapshot);
      if (tree || elementCount > 0) {
        postSnapshot = { tree, elementCount };
      }
    }

    // 检测是否打开了新标签页
    const newTabOpened = Boolean(clickData.newTabOpened);

    // 组装 summary
    const parts: string[] = ['已点击元素'];
    if (changeSummary) {
      parts.push(changeSummary);
    }
    if (postSnapshot) {
      parts.push(`快照: ${postSnapshot.elementCount} 个元素`);
    }

    return {
      ok: true,
      summary: parts.join(' | '),
      data: {
        clicked: true,
        changeSummary,
        newTabOpened,
        postSnapshot,
      },
    };
  },
};

/**
 * 点击指定元素（可通过 CommandRunner 直接调用）
 */
export async function click(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ClickData>> {
  return runCommand(def, args, client);
}
