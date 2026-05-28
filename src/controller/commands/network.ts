/**
 * 网络监控查询命令 — network
 *
 * 网络监听在 navigate 时自动启动，新 tab 自动加入。
 * 此命令仅提供查询能力：
 * - action: 'list' — 列出捕获的请求
 * - action: 'detail' — 查看单个请求详情
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

export type NetworkAction = 'list' | 'detail';

export interface NetworkInput {
  action: NetworkAction;
  filter?: string;
  limit?: number;
  method?: string;
  statusCode?: number;
  requestId?: string;
  tabId?: number;
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
  requestId: string;
  id?: string;
  ids?: unknown;
  webRequestId?: string | null;
  cdpRequestId?: string | null;
  mergeConfidence?: string;
  mergedFrom?: unknown;
  method: string;
  url: string;
  tabId?: number | null;
  status?: string | null;
  statusCode: number | null;
  statusText?: string | null;
  requestHeaders?: unknown;
  requestBody?: unknown;
  responseHeaders?: unknown;
  mimeType?: string | null;
  body?: string | null;
  json?: unknown;
  base64Encoded?: boolean;
  bodyLength?: number;
  bodyError?: unknown;
  artifactRecommended?: boolean;
  artifact?: unknown;
}

export type NetworkData = NetworkListData | NetworkDetailData;

// ─── 命令定义 ────────────────────────────────────────────────────

const networkDef: CommandDefinition<NetworkInput, NetworkData> = {
  name: 'network',
  requiredArgs: ['action'],

  validate: (args: Record<string, unknown>): NetworkInput => {
    const action = args.action as string;
    if (!['list', 'detail'].includes(action)) {
      throw new Error('action 必须是 "list" 或 "detail"');
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
    return {
      action: action as NetworkAction,
      filter: args.filter as string | undefined,
      limit: args.limit as number | undefined,
      method: args.method as string | undefined,
      statusCode: args.statusCode as number | undefined,
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
      case 'list': {
        if (!rawData) {
          return {
            ok: false,
            summary: '网络请求列表获取失败: daemon 未返回结果',
            nextSteps: ['请确认已执行 navigate 以启动自动网络监听'],
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
          count, requests,
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
        if (typeof rawData.error === 'string' && rawData.error) {
          return {
            ok: false,
            summary: `请求详情获取失败: ${rawData.error}`,
            nextSteps: ['请确认 requestId 有效'],
          };
        }
        const method = typeof rawData.method === 'string' ? rawData.method : '';
        const url = typeof rawData.url === 'string' ? rawData.url : '';
        if (!method || !url) {
          return {
            ok: false,
            summary: '请求详情获取失败: extension 未返回 method/url',
            nextSteps: ['请确认 requestId 有效'],
          };
        }
        const statusCode = typeof rawData.statusCode === 'number' ? rawData.statusCode : null;
        const requestId = String(rawData.requestId || rawData.id || '');
        return {
          ok: true,
          summary: `请求详情: ${method} ${url} → ${statusCode}`,
          requestId,
          id: typeof rawData.id === 'string' ? rawData.id : undefined,
          ids: rawData.ids,
          webRequestId: typeof rawData.webRequestId === 'string' ? rawData.webRequestId : null,
          cdpRequestId: typeof rawData.cdpRequestId === 'string' ? rawData.cdpRequestId : null,
          mergeConfidence: typeof rawData.mergeConfidence === 'string' ? rawData.mergeConfidence : undefined,
          mergedFrom: rawData.mergedFrom,
          method,
          url,
          tabId: typeof rawData.tabId === 'number' ? rawData.tabId : null,
          status: typeof rawData.status === 'string' ? rawData.status : null,
          statusCode,
          statusText: typeof rawData.statusText === 'string' ? rawData.statusText : null,
          requestHeaders: rawData.requestHeaders,
          requestBody: rawData.requestBody,
          responseHeaders: rawData.responseHeaders,
          mimeType: typeof rawData.mimeType === 'string' ? rawData.mimeType : null,
          body: typeof rawData.body === 'string' ? rawData.body : null,
          json: rawData.json,
          base64Encoded: Boolean(rawData.base64Encoded),
          bodyLength: typeof rawData.bodyLength === 'number' ? rawData.bodyLength : undefined,
          bodyError: rawData.bodyError,
          artifactRecommended: Boolean(rawData.artifactRecommended),
          artifact: rawData.artifact,
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
