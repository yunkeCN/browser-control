/**
 * 下载命令 — download
 *
 * 功能: 从 URL 通过浏览器下载文件
 * 使用场景: 下载网页中的文件到本地
 *
 * 设计要点:
 * - 参数验证使用简单的手动检查（不使用 Zod schema）
 * - url 必须是非空字符串
 * - filename 和 saveAs 为可选项
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** download 命令的输入参数 */
export interface DownloadInput {
  /** 要下载文件的 URL（必填） */
  url: string;
  /** 保存文件名（可选，由浏览器决定默认名） */
  filename?: string;
  /** 是否显示保存对话框（可选，默认 false） */
  saveAs?: boolean;
}

/** download 命令的输出数据 */
export interface DownloadData {
  /** 是否成功下载 */
  downloaded: boolean;
  /** 下载来源的 URL */
  url: string;
  /** 保存的文件名（daemon 返回时提供） */
  filename?: string;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<DownloadInput, DownloadData> = {
  name: 'download',
  requiredArgs: ['url'],

  /**
   * 参数验证
   * 使用简单的手动检查：
   * - url 不能为空
   * - filename 和 saveAs 可选
   */
  validate: (args: Record<string, unknown>): DownloadInput => {
    if (typeof args.url !== 'string' || args.url.length === 0) {
      throw new Error('url 必须是有效的非空字符串');
    }

    if (args.filename !== undefined && typeof args.filename !== 'string') {
      throw new Error('filename 必须是字符串');
    }

    if (args.saveAs !== undefined && typeof args.saveAs !== 'boolean') {
      throw new Error('saveAs 必须是布尔值');
    }

    return {
      url: args.url as string,
      filename: args.filename as string | undefined,
      saveAs: args.saveAs as boolean | undefined,
    };
  },

  /**
   * 执行下载
   * 通过 DaemonClient 向 daemon 发送 download 命令
   */
  execute: async (
    input: DownloadInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope('download', input as unknown as Record<string, unknown>);
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取 daemon 返回的业务数据
   * - 生成包含 URL 的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<DownloadData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '下载失败: daemon 未返回下载结果',
        nextSteps: ['请确认 URL 是否可访问', '检查 daemon 是否在运行'],
      };
    }

    const downloaded = Boolean(rawData.downloaded);
    const url = String(rawData.url || '');
    const filename = rawData.filename ? String(rawData.filename) : undefined;

    if (!downloaded) {
      return {
        ok: false,
        summary: '下载未生效: daemon 未能完成下载',
        nextSteps: ['请确认 URL 是否可访问', '检查文件保存路径是否有权限'],
      };
    }

    return {
      ok: true,
      summary: `已下载来自 ${url} 的文件`,
      downloaded: true,
      url,
      filename,
    };
  },
};

/**
 * 从 URL 通过浏览器下载文件（可通过 CommandRunner 直接调用）
 */
export async function download(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<DownloadData>> {
  return runCommand(def, args, client);
}
