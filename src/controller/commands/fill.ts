/**
 * 填充命令 — fill
 *
 * 功能: 在页面元素中填入指定内容
 * 使用场景: 填写输入框、文本框、搜索框等
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

/** fill 命令的输入参数 */
export interface FillInput {
  /** 目标元素引用（必填，格式: @e<id> 或 css=<selector>） */
  target: string;
  /** 要填入的内容（必填） */
  value: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 填写策略（可选，默认由 daemon 决定） */
  strategy?: string;
  /** 是否先清除原有内容（可选，默认 false） */
  clear?: boolean;
  /** 填写后的提交方式（可选，change/blur/enter/none） */
  commit?: string;
}

/** fill 命令的输出数据 */
export interface FillData {
  /** 是否成功填入 */
  filled: boolean;
  /** 内容变更摘要（如有变化） */
  changeSummary?: string;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<FillInput, FillData> = {
  name: 'fill',
  requiredArgs: ['target', 'value'],

  /**
   * 参数验证
   * 使用简单的手动检查：
   * - target 不能为空，且必须以 @e 或 css= 开头
   * - value 必须为非空字符串
   */
  validate: (args: Record<string, unknown>): FillInput => {
    const target = args.target;
    if (!target || typeof target !== 'string') {
      throw new Error('target 必须是字符串');
    }
    if (!target.startsWith('@e') && !target.startsWith('css=')) {
      throw new Error('target 格式无效，必须以 @e 或 css= 开头');
    }

    const value = args.value;
    if (value === undefined || value === null) {
      throw new Error('value 不能为空');
    }

    return args as unknown as FillInput;
  },

  /**
   * 执行填充
   * 通过 DaemonClient 向 daemon 发送 fill 命令
   */
  execute: async (
    input: FillInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope('fill', input as unknown as Record<string, unknown>);
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取 daemon 返回的业务数据
   * - 生成包含目标元素和输入内容的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<FillData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '填充失败: daemon 未返回填充结果',
        nextSteps: ['请确认目标元素仍存在于页面中', '重试 fill 命令'],
      };
    }

    const target = String(rawData.target || '');
    const value = String(rawData.value || '');
    const changeSummary = rawData.changeSummary
      ? String(rawData.changeSummary)
      : undefined;

    return {
      ok: true,
      summary: `已填写元素 ${target} | 输入内容: ${value}`,
      data: {
        filled: true,
        changeSummary,
      },
    };
  },
};

/**
 * 在页面元素中填入指定内容（可通过 CommandRunner 直接调用）
 */
export async function fill(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<FillData>> {
  return runCommand(def, args, client);
}
