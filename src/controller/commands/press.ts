/**
 * 按键命令 — press
 *
 * 功能: 在页面中按下指定按键（可带修饰键）
 * 使用场景: 回车提交、快捷键操作、组合键等
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

/** press 命令的输入参数 */
export interface PressInput {
  /** 要按下的键名（必填，如 Enter、Tab、Escape、ArrowDown 等） */
  key: string;
  /** 目标元素引用（可选，聚焦到指定元素后再按键） */
  target?: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 按键策略（可选，默认由 daemon 决定） */
  strategy?: string;
  /** 修饰键列表（可选，如 ["Control", "Shift"]） */
  modifiers?: string[];
}

/** press 命令的输出数据 */
export interface PressData {
  /** 是否成功按键 */
  pressed: boolean;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<PressInput, PressData> = {
  name: 'press',
  requiredArgs: ['key'],

  /**
   * 参数验证
   * 使用简单的手动检查：
   * - key 必须为非空字符串
   */
  validate: (args: Record<string, unknown>): PressInput => {
    const key = args.key;
    if (!key || typeof key !== 'string') {
      throw new Error('key 必须是字符串且不能为空');
    }

    return args as unknown as PressInput;
  },

  /**
   * 执行按键
   * 通过 DaemonClient 向 daemon 发送 press 命令
   */
  execute: async (
    input: PressInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope('press', input as unknown as Record<string, unknown>);
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取 daemon 返回的业务数据
   * - 生成包含按键名称的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<PressData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '按键失败: daemon 未返回按键结果',
        nextSteps: ['请确认页面已加载完成', '重试 press 命令'],
      };
    }

    const key = String(rawData.key || '');

    return {
      ok: true,
      summary: `已按键: ${key}`,
      data: {
        pressed: true,
      },
    };
  },
};

/**
 * 在页面中按下指定按键（可通过 CommandRunner 直接调用）
 */
export async function press(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<PressData>> {
  return runCommand(def, args, client);
}
