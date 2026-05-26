/**
 * 通用控制层 — 命令执行框架 (CommandRunner)
 *
 * 统一编排流程:
 *   validate → execute daemon → handle errors → toResult → CommandResult
 *
 * 所有命令都通过此框架执行，确保:
 * - 一致的参数验证和错误处理
 * - 一致的输出格式 (CommandResult)
 * - 统一的 daemon 通信方式
 */

import type { DaemonClient } from '../mcp/daemon-client';
import type { CommandResult, CommandDefinition } from './types';
export type { CommandDefinition };

/**
 * 统一执行入口
 *
 * 执行流程:
 * 1. validate — 参数验证
 * 2. execute — 调用 daemon
 * 3. 检查 daemon 响应中的 ok 字段
 * 4. toResult — 转换为 CommandResult
 *
 * 如果以上任何步骤抛出异常，返回错误 CommandResult
 */
export async function runCommand<TInput, TData>(
  def: CommandDefinition<TInput, TData>,
  args: Record<string, unknown>,
  daemon: DaemonClient,
): Promise<CommandResult<TData>> {
  // ── 提取信封字段（session/timeoutMs/id），避免干扰验证 ──
  const { session, timeoutMs, id, ...commandArgs } = args;

  // ── 1. 参数验证 ──────────────────────────────────────────────
  let input: TInput;
  try {
    input = def.validate(commandArgs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const missingFields = def.requiredArgs.filter(
      (field) => commandArgs[field] === undefined || commandArgs[field] === null,
    );
    const nextSteps: string[] = [];
    if (missingFields.length > 0) {
      nextSteps.push(`请提供必填参数: ${missingFields.join(', ')}`);
    }
    return {
      ok: false,
      summary: `参数验证失败: ${message}`,
      nextSteps,
    };
  }

  // ── 2. 调用 daemon ───────────────────────────────────────────
  let raw: Record<string, unknown>;
  try {
    // 重新注入信封字段，使 buildEnvelope 能提取 session/timeoutMs/id
    const executeArgs = {
      ...(input as unknown as Record<string, unknown>),
      ...(session !== undefined ? { session } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(id !== undefined ? { id } : {}),
    };
    raw = await def.execute(executeArgs as TInput, daemon);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: `daemon 执行失败: ${message}`,
      nextSteps: [
        '请运行 browser_control_status 或 browser_control_doctor 检查 daemon 状态',
        '如果 daemon 未运行，请等待自动启动或手动启动 daemon',
      ],
    };
  }

  // ── 3. 检查 daemon 业务错误 ──────────────────────────────────
  if (raw?.ok === false) {
    const errMsg =
      typeof raw.error === 'object' && raw.error
        ? ((raw.error as Record<string, unknown>).message as string) ||
          String(raw.error)
        : '未知错误';
    const details =
      typeof raw.error === 'object' && raw.error
        ? (raw.error as Record<string, unknown>).details
        : undefined;
    const nextSteps: string[] = [];
    if (
      details &&
      typeof details === 'object' &&
      Array.isArray((details as Record<string, unknown>).nextSteps)
    ) {
      nextSteps.push(
        ...((details as Record<string, unknown>).nextSteps as string[]),
      );
    }
    return {
      ok: false,
      summary: `执行失败: ${errMsg}`,
      nextSteps: nextSteps.length > 0 ? nextSteps : undefined,
    };
  }

  // ── 4. 转换为 LLM-friendly 输出 ─────────────────────────────
  try {
    return def.toResult(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: `结果转换失败: ${message}`,
      nextSteps: ['这是一个内部错误，请联系开发者'],
    };
  }
}
