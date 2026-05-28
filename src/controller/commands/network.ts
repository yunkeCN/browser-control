/**
 * 统一网络监控命令 — network
 *
 * 通过 action 参数区分操作:
 * - action: 'start' — 启动网络请求监控
 * - action: 'list' — 列出已捕获的网络请求
 * - action: 'detail' — 获取某个请求的详细信息
 * - action: 'stop' — 停止网络监控
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

export type NetworkAction = 'start' | 'list' | 'detail' | 'stop';

export interface NetworkInput {
  action: NetworkAction;
  // start 参数
  filter?: string;
  scope?: 'session' | 'tab';
  // list 参数
  limit?: number;
  method?: string;
  statusCode?: number;
  type?: string;
  sinceTimestampMs?: number;
  // detail 参数
  requestId?: string;
  // 通用
  tabId?: number;
}

export interface NetworkStartData {
  started: boolean;
  filter?: string;
}

export interface NetworkListData {
  count: number;
  requests: Array<{
    id: string;
    method: string;
    url: string;
    statusCode?: number;
  }>;
}

export interface NetworkDetailData {
  request: { method: string; url: string; statusCode: number };
  response?: { statusCode: number };
}

export interface NetworkStopData {
  stopped: boolean;
}

export type NetworkData = NetworkStartData | NetworkListData | NetworkDetailData | NetworkStopData;

// ─── 命令定义 ────────────────────────────────────────────────────

const networkDef: CommandDefinition<NetworkInput, NetworkData> = {
  name: 'network',
  requiredArgs: ['action'],

  validate: (args: Record<string, unknown>): NetworkInput => {
    const action = args.action as string;
    if (!['start', 'list', 'detail', 'stop'].includes(action)) {
      throw new Error('action 必须是 "start"、"list"、"detail" 或 "stop"');
    }
    if (action === 'detail' && (!args.requestId || typeof args.requestId !== 'string')) {
      throw new Error('detail 操作需要提供 requestId 字符串参数');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.filter !== undefined && typeof args.filter !== 'string') {
      throw new Error('filter 必须是字符串');
    }
    if (args.limit !== undefined && typeof args.limit !== 'number') {
      throw new Error('limit 必须是数字');
    }
    if (args.scope !== undefined && args.scope !== 'session' && args.scope !== 'tab') {
      throw new Error('scope 必须是 "session" 或 "tab"');
    }
    return {
      action: action as NetworkAction,
      filter: args.filter as string | undefined,
      scope: args.scope as 'session' | 'tab' | undefined,
      limit: args.limit as number | undefined,
      method: args.method as string | undefined,
      statusCode: args.statusCode as number | undefined,
      type: args.type as string | undefined,
      sinceTimestampMs: args.sinceTimestampMs as number | undefined,
      requestId: args.requestId as string | undefined,
      tabId: args.tabId as number | undefined,
    };
  },

  execute: async (
    input: NetworkInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const daemonCommand = `network_${input.action}`;
    const { action, ...rest } = input;
    const envelope = daemon.buildEnvelope(
      daemonCommand,
      rest as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return { ...response.data as Record<string, unknown>, _action: action };
  },

  toResult: (raw: Record<string, unknown>): CommandResult<NetworkData> => {
    const action = raw._action as string;
    const rawData = raw.data as Record<string, unknown> | undefined;

    switch (action) {
      case 'start': {
        if (!rawData) {
          return {
            ok: false,
            summary: '网络监控启动失败: daemon 未返回结果',
            nextSteps: ['请确认 daemon 运行正常'],
          };
        }
        const started = rawData.started === true || rawData.started === undefined;
        const filter = rawData.filter ? String(rawData.filter) : undefined;
        const filterText = filter ? `（filter: ${filter}）` : '';
        return {
          ok: started,
          summary: started ? `网络监控已启动${filterText}` : '网络监控启动失败',
          data: { started, filter },
        };
      }

      case 'list': {
        if (!rawData) {
          return {
            ok: false,
            summary: '网络请求列表获取失败: daemon 未返回结果',
            nextSteps: ['请确认网络监控已启动'],
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
          data: { count, requests },
        };
      }

      case 'detail': {
        if (!rawData) {
          return {
            ok: false,
            summary: '请求详情获取失败: daemon 未返回结果',
            nextSteps: ['请确认 requestId 有效'],
          };
        }
        const requestRaw = rawData.request as Record<string, unknown> | undefined;
        if (!requestRaw) {
          return {
            ok: false,
            summary: '请求详情获取失败: daemon 未返回请求数据',
            nextSteps: ['请确认 requestId 有效'],
          };
        }
        const method = String(requestRaw.method || '');
        const url = String(requestRaw.url || '');
        const statusCode = Number(requestRaw.statusCode) || 0;
        const responseRaw = rawData.response as Record<string, unknown> | undefined;
        const response = responseRaw ? { statusCode: Number(responseRaw.statusCode) || 0 } : undefined;
        return {
          ok: true,
          summary: `请求详情: ${method} ${url} → ${statusCode}`,
          data: { request: { method, url, statusCode }, response },
        };
      }

      case 'stop': {
        if (!rawData) {
          return {
            ok: false,
            summary: '网络监控停止失败: daemon 未返回结果',
            nextSteps: ['请确认网络监控已启动'],
          };
        }
        const stopped = rawData.stopped !== false;
        return {
          ok: stopped,
          summary: stopped ? '网络监控已停止' : '网络监控停止失败',
          data: { stopped },
        };
      }

      default:
        return { ok: false, summary: `未知操作: ${action}` };
    }
  },
};

export async function network(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<NetworkData>> {
  return runCommand(networkDef, args, client);
}
