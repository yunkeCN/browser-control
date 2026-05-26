/**
 * JS 执行命令 — evaluate
 *
 * 功能: 在目标页面的浏览器上下文中执行 JavaScript 代码
 * 使用场景: 获取页面动态数据、触发页面行为、读取不可见的 DOM 状态
 *
 * 设计要点:
 * - 参数验证复用 protocol.ts 的 schema 定义
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** evaluate 命令的输入参数 */
export interface EvaluateInput {
  /** 要执行的 JavaScript 代码（必填） */
  code: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
}

/** evaluate 命令的输出数据 */
export interface EvaluateData {
  /** JavaScript 执行结果 */
  result: unknown;
  /** 结果类型，如 "string"、"number"、"object"、"boolean"、"undefined" */
  type: string;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<EvaluateInput, EvaluateData> = {
  name: 'evaluate',
  requiredArgs: ['code'],

  validate: (args: Record<string, unknown>): EvaluateInput => {
    if (args.code === undefined || args.code === null) {
      throw new Error('缺少必填参数 code');
    }
    if (typeof args.code !== 'string') {
      throw new Error('code 必须是字符串');
    }
    if (args.code === '') {
      throw new Error('code 不能为空');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    return args as unknown as EvaluateInput;
  },

  execute: async (
    input: EvaluateInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'evaluate',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<EvaluateData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData || rawData.result === undefined) {
      return {
        ok: false,
        summary: 'JS 执行失败: daemon 未返回执行结果',
        nextSteps: ['请检查 JavaScript 代码语法', '确认当前标签页存在', '重试 evaluate 命令'],
      };
    }

    const result = rawData.result;
    const type = typeof result;

    return {
      ok: true,
      summary: `JS 执行完成 | 返回类型: ${type}`,
      data: {
        result,
        type,
      },
    };
  },
};

/**
 * 在目标页面中执行 JavaScript 代码
 */
export async function evaluate(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<EvaluateData>> {
  return runCommand(def, args, client);
}
