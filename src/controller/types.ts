/**
 * 通用控制层 — 类型定义
 *
 * 设计目标：
 * - 所有命令的输出统一为 CommandResult 结构（扁平化）
 * - LLM 应能在 1 秒内理解发生了什么、数据是什么、下一步怎么做
 * - 命令特有的业务字段直接放在顶层，不嵌套在 data 中
 */

import type { DaemonClient } from '../mcp/daemon-client';

/**
 * 命令执行结果
 *
 * 扁平结构：ok/summary/nextSteps/baselineId 是固定字段，
 * 命令特有的业务字段（如 clicked, tabs, filePath 等）直接展开在同一层。
 */
export type CommandResult<T = Record<string, unknown>> = {
  ok: boolean;
  summary: string;
  baselineId?: string;
  nextSteps?: string[];
} & Partial<T>;

/**
 * 命令定义
 * 每个命令只需实现 validate / execute / toResult 三个钩子，
 * 由 CommandRunner 统一编排执行流程
 */
export interface CommandDefinition<TInput, TData> {
  name: string;
  requiredArgs: string[];
  validate: (args: Record<string, unknown>) => TInput;
  execute: (input: TInput, daemon: DaemonClient) => Promise<Record<string, unknown>>;
  toResult: (raw: Record<string, unknown>) => CommandResult<TData>;
}
