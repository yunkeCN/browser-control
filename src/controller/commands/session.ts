/**
 * 会话管理命令 — closeSession
 *
 * 功能: 关闭浏览器会话
 * 使用场景: 退出当前会话、清理浏览器状态
 *
 * 设计要点:
 * - 参数验证使用简单检查
 * - 协议命令使用下划线命名（close_session）
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** closeSession 命令的输入参数 */
export interface CloseSessionInput {
  /** 要关闭的会话 ID（可选，默认关闭当前会话） */
  session?: string;
}

/** closeSession 命令的输出数据 */
export interface CloseSessionData {
  /** 是否成功关闭 */
  closed: boolean;
  /** 关闭后当前的活跃会话 ID */
  activeSession?: string;
}

// ─── closeSession 命令定义 ──────────────────────────────────────────

const closeSessionDef: CommandDefinition<CloseSessionInput, CloseSessionData> = {
  name: 'close_session',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): CloseSessionInput => {
    if (args.session !== undefined && typeof args.session !== 'string') {
      throw new Error('session 必须是字符串');
    }
    return {
      session: args.session as string | undefined,
    };
  },

  execute: async (
    input: CloseSessionInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'close_session',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<CloseSessionData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '关闭会话失败: daemon 未返回结果',
        nextSteps: ['请确认 daemon 正在运行', '重试 close_session 命令'],
      };
    }

    const closed = Boolean(rawData.closed);
    if (!closed) {
      return {
        ok: false,
        summary: '关闭会话失败',
        nextSteps: ['该会话可能已被关闭', '请检查会话状态'],
      };
    }

    const activeSession = rawData.activeSession as string | undefined;

    return {
      ok: true,
      summary: `会话已关闭 | 当前活跃会话: ${activeSession || '无'}`,
      closed: true,
      activeSession,
    };
  },
};

// ─── 导出函数 ──────────────────────────────────────────────────────

/**
 * 关闭指定会话（可通过 CommandRunner 直接调用）
 */
export async function closeSession(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<CloseSessionData>> {
  return runCommand(closeSessionDef, args, client);
}
