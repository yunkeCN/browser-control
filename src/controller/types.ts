/**
 * 通用控制层 — 类型定义
 *
 * 设计目标：
 * - 所有命令的输出统一为 CommandResult<T> 结构
 * - LLM 应能在 1 秒内理解发生了什么、数据是什么、下一步怎么做
 * - 调试信息（时间戳、diagnostics 等）不包含在 CommandResult 中
 */

import type { DaemonClient } from '../mcp/daemon-client';

/**
 * 命令执行结果
 * 所有 Controller 命令的统一输出结构
 */
export interface CommandResult<T = unknown> {
  /** 操作是否成功 */
  ok: boolean;

  /**
   * 对 LLM 友好的操作结果摘要（一句话）
   *
   * 格式: "<做了什么>: <关键结果>"
   * 成功示例:
   *   "已导航到 https://example.com"
   *   "页面快照: 在「Google」找到 12 个交互元素"
   * 失败示例:
   *   "无法导航: 缺少必填参数 url"
   *   "daemon 未响应: Connection refused"
   */
  summary: string;

  /**
   * 核心业务数据
   * 不同命令的数据结构不同，只包含该命令特有的信息
   * 失败时为 undefined
   */
  data?: T;

  /**
   * 快照基线 ID（snapshot/click 自动生成，可用于 diff_to 对比）
   */
  baselineId?: string;

  /**
   * LLM 下一步动作建议（按优先级排序）
   * 仅在需要提示下一步时提供，成功时一般为 undefined
   *
   * 示例: ["请使用 snapshot 获取当前页面元素", "检查 daemon 是否在运行"]
   */
  nextSteps?: string[];

  /**
   * 风险提示
   * 敏感操作（click/fill/evaluate/upload 等）时提供
   */
  riskNotes?: string[];
}

/**
 * 命令定义
 * 每个命令只需实现 validate / execute / toResult 三个钩子，
 * 由 CommandRunner 统一编排执行流程
 */
export interface CommandDefinition<TInput, TData> {
  /** 命令名称（与 protocol.ts 中的 COMMANDS 一致） */
  name: string;

  /** 必填参数字段名列表（用于快速检测缺失参数） */
  requiredArgs: string[];

  /**
   * 1. 参数验证
   * @throws 验证失败时抛出错误，runner 会捕获并生成错误 CommandResult
   */
  validate: (args: Record<string, unknown>) => TInput;

  /**
   * 2. 通过 DaemonClient 执行命令
   * 返回 daemon 响应中的 data 字段（已剥去 envelope）
   */
  execute: (input: TInput, daemon: DaemonClient) => Promise<
    Record<string, unknown>
  >;

  /**
   * 3. 将 daemon 原始响应数据转换为 LLM-friendly 的 CommandResult
   *
   * @param raw - daemon 响应的 data 字段（已通过 execute 获取）
   * @returns CommandResult，其中 data 为 TData 类型
   */
  toResult: (raw: Record<string, unknown>) => CommandResult<TData>;
}
