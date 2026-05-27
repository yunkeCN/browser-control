/**
 * 点击探测命令 — click_probe
 *
 * 功能: 点击页面上的指定元素，同时捕获点击期间的网络请求
 * 使用场景: 需要验证点击触发了正确的 API 调用
 *
 * 设计要点:
 * - 参数验证使用简单检查（非 Zod schema）
 * - target 必须是 @e<structureId>_<revision> 引用或 css=<selector> 选择器
 * - 支持 filter 过滤网络请求捕获范围
 * - 成功返回 LLM-friendly 的 summary + 结构化 data（含 captured requests）
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** click_probe 命令的输入参数 */
export interface ClickProbeInput {
  /** 目标元素引用（@e 引用或 css= 选择器） */
  target: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 是否强制点击（可选，跳过可见性检查） */
  force?: boolean;
  /** URL 子串过滤条件，用于只捕获匹配的请求 */
  filter?: string;
  /** 是否包含响应头（可选） */
  includeHeaders?: boolean;
  /** 是否包含响应体（可选） */
  includeBody?: boolean;
  /** 是否对敏感信息脱敏（可选） */
  redactSensitive?: boolean;
  /** 最大捕获请求数（可选） */
  maxRequests?: number;
}

/** click_probe 命令的输出数据 */
export interface ClickProbeData {
  /** 是否成功点击 */
  clicked: boolean;
  /** 捕获的网络请求列表 */
  networkRequests?: Array<{
    url: string;
    method: string;
    statusCode?: number;
  }>;
  /** 请求总数 */
  requestCount?: number;
}

// ─── 辅助函数 ────────────────────────────────────────────────────

/** @e 引用正则: @e<structureId>_<revision> */
const ELEMENT_REF_RE = /^@e[^\s_]+_\d+$/;

/** CSS 选择器前缀 */
const CSS_PREFIX = 'css=';

/**
 * 验证 target 是否有效
 * - @e<structureId>_<revision> 格式（来自快照的引用）
 * - css=<selector> 格式（显式 CSS 选择器）
 */
function isValidTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0) return false;
  return ELEMENT_REF_RE.test(target) || target.startsWith(CSS_PREFIX);
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<ClickProbeInput, ClickProbeData> = {
  name: 'click_probe',
  requiredArgs: ['target'],

  /**
   * 参数验证
   * 使用简单检查确保 target 格式正确，可选参数类型正确
   */
  validate: (args: Record<string, unknown>): ClickProbeInput => {
    if (!isValidTarget(args.target)) {
      throw new Error(
        'target 必须是 @e<structureId>_<revision> 引用或 css=<selector> 选择器',
      );
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.force !== undefined && typeof args.force !== 'boolean') {
      throw new Error('force 必须是布尔值');
    }
    if (args.filter !== undefined && typeof args.filter !== 'string') {
      throw new Error('filter 必须是字符串');
    }
    if (args.includeHeaders !== undefined && typeof args.includeHeaders !== 'boolean') {
      throw new Error('includeHeaders 必须是布尔值');
    }
    if (args.includeBody !== undefined && typeof args.includeBody !== 'boolean') {
      throw new Error('includeBody 必须是布尔值');
    }
    if (args.redactSensitive !== undefined && typeof args.redactSensitive !== 'boolean') {
      throw new Error('redactSensitive 必须是布尔值');
    }
    if (args.maxRequests !== undefined && typeof args.maxRequests !== 'number') {
      throw new Error('maxRequests 必须是数字');
    }
    return {
      target: args.target as string,
      tabId: args.tabId as number | undefined,
      force: args.force as boolean | undefined,
      filter: args.filter as string | undefined,
      includeHeaders: args.includeHeaders as boolean | undefined,
      includeBody: args.includeBody as boolean | undefined,
      redactSensitive: args.redactSensitive as boolean | undefined,
      maxRequests: args.maxRequests as number | undefined,
    };
  },

  /**
   * 执行点击探测
   * 通过 DaemonClient 向 daemon 发送 click_probe 命令
   */
  execute: async (
    input: ClickProbeInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'click_probe',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取点击结果（clicked）
   * - 提取捕获的网络请求列表
   * - 生成包含点击结果和请求数量的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<ClickProbeData> => {
    const clickData = raw.data as Record<string, unknown> | undefined;

    if (!clickData) {
      return {
        ok: false,
        summary: '点击探测失败: daemon 未返回结果',
        nextSteps: ['请确认目标元素在当前页面中存在', '重试 click_probe 命令'],
      };
    }

    const clicked = Boolean(clickData.clicked);
    if (!clicked) {
      return {
        ok: false,
        summary: '点击未生效: 元素可能不可点击或已被移除',
        nextSteps: ['请使用 snapshot 刷新页面元素状态后重试'],
      };
    }

    // 提取网络请求列表
    const rawRequests = clickData.networkRequests;
    const networkRequests = Array.isArray(rawRequests)
      ? rawRequests.map((r: unknown) => {
          const req = r as Record<string, unknown>;
          return {
            url: String(req.url || ''),
            method: String(req.method || ''),
            statusCode: req.statusCode !== undefined ? Number(req.statusCode) : undefined,
          };
        })
      : undefined;

    const requestCount =
      typeof clickData.requestCount === 'number'
        ? clickData.requestCount
        : networkRequests ? networkRequests.length : 0;

    // 组装 summary
    const parts: string[] = ['已点击元素'];
    if (requestCount !== undefined && requestCount > 0) {
      parts.push(`捕获到 ${requestCount} 个网络请求`);
    } else {
      parts.push('未捕获到网络请求');
    }

    return {
      ok: true,
      summary: parts.join(' | '),
      data: {
        clicked: true,
        networkRequests,
        requestCount,
      },
    };
  },
};

/**
 * 点击指定元素并捕获网络请求（可通过 CommandRunner 直接调用）
 */
export async function clickProbe(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ClickProbeData>> {
  return runCommand(def, args, client);
}
