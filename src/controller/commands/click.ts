/**
 * 统一点击命令 — click
 *
 * 三种模式:
 * 1. 基础点击: { target: "@eref_1" } — 通过 @e ref 或 css= 选择器点击
 * 2. 请求拦截点击: { target: "@eref_1", probe: { filter: "/api/" } } — 点击 + CDP 网络拦截
 * 3. 文本定位点击: { text: "Submit", x: 200, y: 300 } — 通过文本+坐标定位并点击
 *
 * target 和 text 互斥，至少提供一个。
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';
import { executeClickProbe, type ClickProbeData, toClickProbeResult } from './click-probe';
import { executeClickText, type ClickTextData, toClickTextResult } from './click-text';

// ─── 类型定义 ────────────────────────────────────────────────────

/** 请求拦截配置 */
export interface ClickProbeOptions {
  /** URL 子串过滤 */
  filter?: string;
  /** 包含响应头 */
  includeHeaders?: boolean;
  /** 包含响应体 */
  includeBody?: boolean;
  /** 对敏感信息脱敏 */
  redactSensitive?: boolean;
  /** 最大捕获请求数 */
  maxRequests?: number;
}

/** click 命令的统一输入参数 */
export interface ClickInput {
  // 模式 1/2: target 定位
  target?: string;
  // 模式 3: text 定位
  text?: string;
  x?: number;
  y?: number;
  roles?: string[];
  // 通用
  tabId?: number;
  force?: boolean;
  // 模式 2: 请求拦截
  probe?: ClickProbeOptions;
}

/** click 命令的输出数据 */
export interface ClickData {
  clicked: boolean;
  newTabOpened?: boolean;
  network?: { requests: string[]; count: number };
}

// ─── 辅助函数 ────────────────────────────────────────────────────

const ELEMENT_REF_RE = /^@e[^\s_]+_\d+$/;
const CSS_PREFIX = 'css=';

function isValidTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0) return false;
  return ELEMENT_REF_RE.test(target) || target.startsWith(CSS_PREFIX);
}

// ─── 命令定义 ────────────────────────────────────────────────────

export const clickDef: CommandDefinition<ClickInput, ClickData | ClickProbeData | ClickTextData> = {
  name: 'click',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): ClickInput => {
    const hasTarget = args.target !== undefined;
    const hasText = args.text !== undefined;

    if (!hasTarget && !hasText) {
      throw new Error('必须提供 target 或 text 参数之一');
    }
    if (hasTarget && hasText) {
      throw new Error('target 和 text 互斥，不能同时提供');
    }

    // text 模式验证
    if (hasText) {
      if (typeof args.text !== 'string' || !(args.text as string).trim()) {
        throw new Error('text 必须是有效的非空字符串');
      }
      if (typeof args.x !== 'number' || !Number.isFinite(args.x as number)) {
        throw new Error('text 模式下 x 是必填数字参数');
      }
      if (typeof args.y !== 'number' || !Number.isFinite(args.y as number)) {
        throw new Error('text 模式下 y 是必填数字参数');
      }
      return {
        text: (args.text as string).trim(),
        x: args.x as number,
        y: args.y as number,
        roles: Array.isArray(args.roles) ? args.roles as string[] : undefined,
        tabId: typeof args.tabId === 'number' ? args.tabId : undefined,
      };
    }

    // target 模式验证
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

    // probe 验证
    let probe: ClickProbeOptions | undefined;
    if (args.probe !== undefined) {
      if (typeof args.probe !== 'object' || args.probe === null || Array.isArray(args.probe)) {
        throw new Error('probe 必须是对象');
      }
      const p = args.probe as Record<string, unknown>;
      probe = {};
      if (p.filter !== undefined) {
        if (typeof p.filter !== 'string') throw new Error('probe.filter 必须是字符串');
        probe.filter = p.filter;
      }
      if (p.includeHeaders !== undefined) {
        if (typeof p.includeHeaders !== 'boolean') throw new Error('probe.includeHeaders 必须是布尔值');
        probe.includeHeaders = p.includeHeaders;
      }
      if (p.includeBody !== undefined) {
        if (typeof p.includeBody !== 'boolean') throw new Error('probe.includeBody 必须是布尔值');
        probe.includeBody = p.includeBody;
      }
      if (p.redactSensitive !== undefined) {
        if (typeof p.redactSensitive !== 'boolean') throw new Error('probe.redactSensitive 必须是布尔值');
        probe.redactSensitive = p.redactSensitive;
      }
      if (p.maxRequests !== undefined) {
        if (typeof p.maxRequests !== 'number') throw new Error('probe.maxRequests 必须是数字');
        probe.maxRequests = p.maxRequests;
      }
    }

    return {
      target: args.target as string,
      tabId: args.tabId as number | undefined,
      force: args.force as boolean | undefined,
      probe,
    };
  },

  execute: async (
    input: ClickInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    // 模式 3: 文本定位点击
    if (input.text) {
      return executeClickText({
        text: input.text,
        x: input.x!,
        y: input.y!,
        roles: input.roles,
        tabId: input.tabId,
      }, daemon);
    }

    // 模式 2: 请求拦截点击
    if (input.probe) {
      return executeClickProbe({
        target: input.target!,
        tabId: input.tabId,
        force: input.force,
        filter: input.probe.filter,
        includeHeaders: input.probe.includeHeaders,
        includeBody: input.probe.includeBody,
        redactSensitive: input.probe.redactSensitive,
        maxRequests: input.probe.maxRequests,
      }, daemon);
    }

    // 模式 1: 基础点击
    const envelope = daemon.buildEnvelope(
      'click',
      { target: input.target, tabId: input.tabId } as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown> || {};
  },

  toResult: (raw: Record<string, unknown>): CommandResult<ClickData | ClickProbeData | ClickTextData> => {
    // 文本定位模式结果
    if (raw._status !== undefined) {
      return toClickTextResult(raw);
    }

    // 请求拦截模式结果
    if (raw._mode === 'probe') {
      return toClickProbeResult(raw);
    }

    // 基础点击结果
    const clickData = raw.data as Record<string, unknown> | undefined;

    if (!clickData) {
      return {
        ok: false,
        summary: '点击失败: daemon 未返回点击结果',
        nextSteps: ['请确认目标元素在当前页面中存在', '重试 click 命令'],
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

    const changes = clickData.changes as Record<string, unknown> | undefined;
    const baselineId = typeof changes?.baselineId === 'string' ? changes.baselineId : undefined;
    const newTabOpened = Boolean(clickData.newTabOpened);
    const rawNetwork = clickData.network as { requests?: string[]; count?: number } | undefined;
    const network = rawNetwork?.requests?.length
      ? { requests: rawNetwork.requests, count: rawNetwork.count || rawNetwork.requests.length }
      : undefined;

    const parts: string[] = ['已点击元素'];
    if (network) {
      parts.push(`触发 ${network.count} 个接口请求`);
    }
    if (baselineId) {
      parts.push(`观察基线: ${baselineId}`);
    }

    return {
      ok: true,
      summary: parts.join(' | '),
      baselineId,
      clicked: true,
      newTabOpened,
      network,
    };
  },
};

/**
 * 统一点击命令入口
 */
export async function click(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ClickData | ClickProbeData | ClickTextData>> {
  return runCommand(clickDef, args, client);
}
