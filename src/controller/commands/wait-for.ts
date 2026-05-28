/**
 * 等待命令 — wait-for
 *
 * 功能: 等待页面上某个元素或文本达到指定状态
 * 使用场景: 等待页面加载完成、等待动态内容出现、等待元素可交互
 *
 * 设计要点:
 * - 支持等待文本出现和选择器匹配两种模式（至少指定其一）
 * - 支持设置超时时间，避免无限等待
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** wait-for 命令的输入参数 */
export interface WaitForInput {
  /** CSS 选择器，等待匹配元素（可选） */
  selector?: string;
  /** 可见文本，等待包含该文本的元素出现（可选） */
  text?: string;
  /** 等待的状态（可选，默认 visible） */
  state?: 'visible' | 'attached' | 'hidden' | 'detached';
  /** 超时时间，单位毫秒（可选，默认 30000） */
  timeoutMs?: number;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
}

/** wait-for 命令的输出数据 */
export interface WaitForData {
  /** 是否成功找到匹配的元素 */
  found: boolean;
  /** 匹配元素到达的状态 */
  state: string;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<WaitForInput, WaitForData> = {
  name: 'wait_for',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): WaitForInput => {
    const validKeys = ['selector', 'text', 'state', 'timeoutMs', 'tabId'];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (args.selector !== undefined && typeof args.selector !== 'string') {
      throw new Error('selector 必须是字符串');
    }
    if (args.text !== undefined && typeof args.text !== 'string') {
      throw new Error('text 必须是字符串');
    }
    if (
      args.state !== undefined &&
      !['visible', 'attached', 'hidden', 'detached'].includes(args.state as string)
    ) {
      throw new Error('state 必须是 visible、attached、hidden 或 detached');
    }
    if (args.timeoutMs !== undefined && typeof args.timeoutMs !== 'number') {
      throw new Error('timeoutMs 必须是数字');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    return args as unknown as WaitForInput;
  },

  execute: async (
    input: WaitForInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'wait_for',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<WaitForData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '等待失败: daemon 未返回等待结果',
        nextSteps: ['请确认当前标签页存在', '重试 wait-for 命令'],
      };
    }

    const found = rawData.found === true;
    const state = String(rawData.state || '');

    if (!found) {
      return {
        ok: false,
        summary: `等待超时: 元素未在指定时间内达到状态 ${state}`,
        nextSteps: [
          '增加 timeoutMs 后重试',
          '检查 selector 或 text 是否正确',
          '确认页面是否已加载',
        ],
      };
    }

    // 构建友好的摘要信息
    const input = (raw as Record<string, unknown>).input as Record<string, unknown> | undefined;
    const text = input?.text ? `文本「${input.text}」` : '';
    const selector = input?.selector ? `选择器「${input.selector}」` : '';
    const target = text || selector || '';

    return {
      ok: true,
      summary: `等待成功: ${target}已变为 ${state}`,
      found,
      state,
    };
  },
};

/**
 * 等待页面上某个元素或文本达到指定状态
 */
export async function waitFor(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<WaitForData>> {
  return runCommand(def, args, client);
}
