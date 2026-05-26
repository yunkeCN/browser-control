/**
 * 网络命令 — network
 *
 * 功能: 管理网络请求监控
 * 使用场景:
 *   - network_start: 启动网络请求监控
 *   - network_list: 列出已捕获的网络请求
 *   - network_detail: 获取某个请求的详细信息
 *   - network_stop: 停止网络监控
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

/** network_start 命令的输入参数 */
export interface NetworkStartInput {
  /** 请求 URL 过滤模式（可选，如 "/api/"） */
  filter?: string;
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 监控范围（可选，session 或 tab） */
  scope?: 'session' | 'tab';
}

/** network_start 命令的输出数据 */
export interface NetworkStartData {
  /** 是否已成功启动 */
  started: boolean;
  /** 应用的过滤条件 */
  filter?: string;
}

/** network_list 命令的输入参数 */
export interface NetworkListInput {
  /** 请求 URL 过滤模式（可选） */
  filter?: string;
  /** 返回的最大请求数（可选） */
  limit?: number;
  /** 标签页 ID（可选） */
  tabId?: number;
}

/** network_list 命令的输出数据 */
export interface NetworkListData {
  /** 请求总数 */
  count: number;
  /** 请求列表 */
  requests: Array<{
    id: string;
    method: string;
    url: string;
    statusCode?: number;
  }>;
}

/** network_detail 命令的输入参数 */
export interface NetworkDetailInput {
  /** 请求 ID（必填） */
  requestId: string;
}

/** network_detail 命令的输出数据 */
export interface NetworkDetailData {
  /** 请求基本信息 */
  request: {
    method: string;
    url: string;
    statusCode: number;
  };
  /** 响应信息 */
  response?: {
    statusCode: number;
  };
}

/** network_stop 命令的输入参数 */
export interface NetworkStopInput {
  // 无参数
}

/** network_stop 命令的输出数据 */
export interface NetworkStopData {
  /** 是否已成功停止 */
  stopped: boolean;
}

// ─── network_start 命令定义 ──────────────────────────────────────

const startDef: CommandDefinition<NetworkStartInput, NetworkStartData> = {
  name: 'network_start',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): NetworkStartInput => {
    const validKeys = ['filter', 'tabId', 'scope'];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (args.filter !== undefined && typeof args.filter !== 'string') {
      throw new Error('filter 必须是字符串');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.scope !== undefined && args.scope !== 'session' && args.scope !== 'tab') {
      throw new Error('scope 必须是 "session" 或 "tab"');
    }
    return args as unknown as NetworkStartInput;
  },

  execute: async (
    input: NetworkStartInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'network_start',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<NetworkStartData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '网络监控启动失败: daemon 未返回结果',
        nextSteps: ['请确认 daemon 运行正常', '重试 network_start 命令'],
      };
    }

    const started = rawData.started === true || rawData.started === undefined;
    const filter = rawData.filter ? String(rawData.filter) : undefined;
    const filterText = filter ? `（filter: ${filter}）` : '';

    return {
      ok: started,
      summary: started
        ? `网络监控已启动${filterText}`
        : '网络监控启动失败',
      data: {
        started,
        filter,
      },
    };
  },
};

// ─── network_list 命令定义 ───────────────────────────────────────

const listDef: CommandDefinition<NetworkListInput, NetworkListData> = {
  name: 'network_list',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): NetworkListInput => {
    const validKeys = ['filter', 'limit', 'tabId'];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (args.filter !== undefined && typeof args.filter !== 'string') {
      throw new Error('filter 必须是字符串');
    }
    if (args.limit !== undefined && typeof args.limit !== 'number') {
      throw new Error('limit 必须是数字');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    return args as unknown as NetworkListInput;
  },

  execute: async (
    input: NetworkListInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'network_list',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<NetworkListData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '网络请求列表获取失败: daemon 未返回结果',
        nextSteps: ['请确认网络监控已启动', '重试 network_list 命令'],
      };
    }

    const rawRequests = rawData.requests;
    const requests = Array.isArray(rawRequests)
      ? rawRequests.map((r: unknown) => {
          const req = r as Record<string, unknown>;
          return {
            id: String(req.id || ''),
            method: String(req.method || ''),
            url: String(req.url || ''),
            statusCode: req.statusCode !== undefined ? Number(req.statusCode) : undefined,
          };
        })
      : [];

    const count = typeof rawData.count === 'number' ? rawData.count : requests.length;

    return {
      ok: true,
      summary: `网络请求: 捕获到 ${count} 个请求`,
      data: {
        count,
        requests,
      },
    };
  },
};

// ─── network_detail 命令定义 ─────────────────────────────────────

const detailDef: CommandDefinition<NetworkDetailInput, NetworkDetailData> = {
  name: 'network_detail',
  requiredArgs: ['requestId'],

  validate: (args: Record<string, unknown>): NetworkDetailInput => {
    const validKeys = ['requestId'];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (!args.requestId || typeof args.requestId !== 'string') {
      throw new Error('requestId 是必填参数且必须是字符串');
    }
    return args as unknown as NetworkDetailInput;
  },

  execute: async (
    input: NetworkDetailInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'network_detail',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<NetworkDetailData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '请求详情获取失败: daemon 未返回结果',
        nextSteps: ['请确认 requestId 有效', '重试 network_detail 命令'],
      };
    }

    const requestRaw = rawData.request as Record<string, unknown> | undefined;
    if (!requestRaw) {
      return {
        ok: false,
        summary: '请求详情获取失败: daemon 未返回请求数据',
        nextSteps: ['请确认 requestId 有效', '重试 network_detail 命令'],
      };
    }

    const method = String(requestRaw.method || '');
    const url = String(requestRaw.url || '');
    const statusCode = Number(requestRaw.statusCode) || 0;

    const responseRaw = rawData.response as Record<string, unknown> | undefined;
    const response = responseRaw
      ? { statusCode: Number(responseRaw.statusCode) || 0 }
      : undefined;

    return {
      ok: true,
      summary: `请求详情: ${method} ${url} → ${statusCode}`,
      data: {
        request: {
          method,
          url,
          statusCode,
        },
        response,
      },
    };
  },
};

// ─── network_stop 命令定义 ───────────────────────────────────────

const stopDef: CommandDefinition<NetworkStopInput, NetworkStopData> = {
  name: 'network_stop',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): NetworkStopInput => {
    const validKeys: string[] = [];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; network_stop 不支持任何参数`,
      );
    }
    return {} as NetworkStopInput;
  },

  execute: async (
    _input: NetworkStopInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'network_stop',
      {} as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<NetworkStopData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '网络监控停止失败: daemon 未返回结果',
        nextSteps: ['请确认网络监控已启动', '重试 network_stop 命令'],
      };
    }

    const stopped = rawData.stopped !== false;

    return {
      ok: stopped,
      summary: stopped ? '网络监控已停止' : '网络监控停止失败',
      data: {
        stopped,
      },
    };
  },
};

// ─── 导出命令函数 ────────────────────────────────────────────────

/**
 * 启动网络请求监控
 */
export async function networkStart(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<NetworkStartData>> {
  return runCommand(startDef, args, client);
}

/**
 * 列出已捕获的网络请求
 */
export async function networkList(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<NetworkListData>> {
  return runCommand(listDef, args, client);
}

/**
 * 获取某个请求的详细信息
 */
export async function networkDetail(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<NetworkDetailData>> {
  return runCommand(detailDef, args, client);
}

/**
 * 停止网络监控
 */
export async function networkStop(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<NetworkStopData>> {
  return runCommand(stopDef, args, client);
}
