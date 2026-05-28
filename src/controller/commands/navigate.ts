/**
 * 导航命令 — navigate
 *
 * 功能: 导航到指定 URL
 * 使用场景: 打开网页、跳转到新页面
 *
 * 设计要点:
 * - 参数验证复用 protocol.ts 的 schema 定义
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import { commandArgSchemas } from '../../mcp/schema';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** navigate 命令的输入参数 */
export interface NavigateInput {
  /** 目标 URL（必填） */
  url: string;
  /** 是否在新标签页中打开（可选，默认 false） */
  newTab?: boolean;
  /** 导航超时时间，单位毫秒（可选，默认 30000） */
  timeoutMs?: number;
}

/** navigate 命令的输出数据 */
export interface NavigateData {
  /** 最终导航到的 URL（可能因重定向而不同） */
  finalUrl: string;
  /** 导航完成后页面的 <title> 内容 */
  title: string;
  /** 当前标签页的 ID，后续命令（snapshot/click 等）可通过此 ID 定位 */
  tabId: number;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<NavigateInput, NavigateData> = {
  name: 'navigate',
  requiredArgs: ['url'],

  /**
   * 参数验证
   * 复用 schema.ts 中的 Zod schema 确保与协议定义一致
   */
  validate: (args: Record<string, unknown>): NavigateInput => {
    const parsed = commandArgSchemas.navigate.safeParse(args);
    if (!parsed.success) {
      const messages = parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      );
      throw new Error(messages.join('; '));
    }
    return parsed.data as unknown as NavigateInput;
  },

  /**
   * 执行导航
   * 通过 DaemonClient 向 daemon 发送 navigate 命令
   */
  execute: async (
    input: NavigateInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope('navigate', input as unknown as Record<string, unknown>);
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取 daemon 返回的业务数据
   * - 生成包含目标 URL 和页面 title 的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<NavigateData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData || !rawData.url) {
      return {
        ok: false,
        summary: '导航失败: daemon 未返回导航结果',
        nextSteps: ['请重试或检查目标 URL 是否可访问'],
      };
    }

    return {
      ok: true,
      summary: `已导航到 ${rawData.url}`,
      finalUrl: String(rawData.url),
      title: String(rawData.title || ''),
      tabId: Number(rawData.tabId) || 0,
    };
  },
};

/**
 * 导航到指定 URL（可通过 CommandRunner 直接调用）
 */
export async function navigate(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<NavigateData>> {
  return runCommand(def, args, client);
}
