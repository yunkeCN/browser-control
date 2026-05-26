/**
 * 滚动命令 — scroll
 *
 * 功能: 滚动页面或指定元素
 * 使用场景: 滚动页面浏览更多内容、滚动到指定位置
 *
 * 设计要点:
 * - 参数验证使用简单的手动检查（不使用 Zod schema）
 * - 支持 deltaX（水平滚动）和 deltaY（垂直滚动）
 * - 支持指定滚动目标元素
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** scroll 命令的输入参数 */
export interface ScrollInput {
  /** 目标元素引用（可选，默认滚动整个页面） */
  target?: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 滚动策略（可选，auto / dom / wheel） */
  strategy?: 'auto' | 'dom' | 'wheel';
  /** 水平滚动量（像素，可选） */
  deltaX?: number;
  /** 垂直滚动量（像素，可选） */
  deltaY?: number;
}

/** scroll 命令的输出数据 */
export interface ScrollData {
  /** 是否成功滚动 */
  scrolled: boolean;
  /** 滚动后的位置描述 */
  newPosition?: string;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<ScrollInput, ScrollData> = {
  name: 'scroll',
  requiredArgs: [],

  /**
   * 参数验证
   * 使用简单的手动检查：
   * - target 可选，提供时必须为字符串
   * - strategy 可选，提供时必须为 auto / dom / wheel 之一
   * - deltaX / deltaY 可选，提供时必须为数字
   */
  validate: (args: Record<string, unknown>): ScrollInput => {
    if (args.target !== undefined && typeof args.target !== 'string') {
      throw new Error('target 必须是字符串');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (
      args.strategy !== undefined &&
      !['auto', 'dom', 'wheel'].includes(args.strategy as string)
    ) {
      throw new Error('strategy 必须是 auto / dom / wheel 之一');
    }
    if (args.deltaX !== undefined && typeof args.deltaX !== 'number') {
      throw new Error('deltaX 必须是数字');
    }
    if (args.deltaY !== undefined && typeof args.deltaY !== 'number') {
      throw new Error('deltaY 必须是数字');
    }

    return args as unknown as ScrollInput;
  },

  /**
   * 执行滚动
   * 通过 DaemonClient 向 daemon 发送 scroll 命令
   */
  execute: async (
    input: ScrollInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope('scroll', input as unknown as Record<string, unknown>);
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取 daemon 返回的业务数据
   * - 生成包含滚动位置的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<ScrollData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '滚动失败: daemon 未返回滚动结果',
        nextSteps: ['请确认页面已加载完成', '重试 scroll 命令'],
      };
    }

    const scrolled = Boolean(rawData.scrolled);
    const newPosition = rawData.newPosition
      ? String(rawData.newPosition)
      : undefined;

    if (!scrolled) {
      return {
        ok: false,
        summary: '滚动未生效: 页面可能已滚动到底部或目标元素不可滚动',
        nextSteps: ['请尝试增大 deltaY 或 deltaX 的值', '确认目标元素存在滚动容器'],
      };
    }

    return {
      ok: true,
      summary: `已滚动页面${newPosition ? ` | ${newPosition}` : ''}`,
      data: {
        scrolled: true,
        newPosition,
      },
    };
  },
};

/**
 * 滚动页面或指定元素（可通过 CommandRunner 直接调用）
 */
export async function scroll(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ScrollData>> {
  return runCommand(def, args, client);
}
