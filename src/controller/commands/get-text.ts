/**
 * 获取页面文本命令 — get-text
 *
 * 功能: 从当前页面获取可见文本内容
 * 使用场景: 读取页面内容、提取搜索结果、获取文章正文
 *
 * 设计要点:
 * - 支持视口/文档/全文三种范围
 * - 支持设置最大字符数，避免文本过长
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** get-text 命令的输入参数 */
export interface GetTextInput {
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 文本获取范围（可选，默认 document） */
  scope?: 'viewport' | 'document' | 'full';
  /** 最大字符数（可选，默认由 daemon 决定） */
  maxChars?: number;
  /** 是否返回 textRuns 数组（可选） */
  includeRuns?: boolean;
  /** CSS 选择器，只获取匹配元素的文本（可选） */
  selector?: string;
}

/** get-text 命令的输出数据 */
export interface GetTextData {
  /** 获取到的页面文本 */
  text: string;
  /** 文本长度（字符数） */
  length: number;
  /** 是否因超出 maxChars 被截断 */
  truncated: boolean;
  /** 页面 URL */
  url?: string;
  /** 页面标题 */
  title?: string;
  /** 文本片段数组（仅 includeRuns:true 时返回） */
  textRuns?: unknown[];
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<GetTextInput, GetTextData> = {
  name: 'get_text',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): GetTextInput => {
    const validKeys = ['tabId', 'scope', 'maxChars', 'includeRuns', 'selector'];
    const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `未知参数: ${unknownKeys.join(', ')}; 支持的参数: ${validKeys.join(', ')}`,
      );
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (
      args.scope !== undefined &&
      !['viewport', 'document', 'full'].includes(args.scope as string)
    ) {
      throw new Error('scope 必须是 viewport、document 或 full');
    }
    if (args.maxChars !== undefined && typeof args.maxChars !== 'number') {
      throw new Error('maxChars 必须是数字');
    }
    if (args.selector !== undefined && typeof args.selector !== 'string') {
      throw new Error('selector 必须是字符串');
    }
    return args as unknown as GetTextInput;
  },

  execute: async (
    input: GetTextInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'get_text',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<GetTextData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData || typeof rawData.text !== 'string') {
      return {
        ok: false,
        summary: '获取文本失败: daemon 未返回文本数据',
        nextSteps: ['请确认当前标签页存在', '重试 get-text 命令'],
      };
    }

    const text = rawData.text as string;
    const length = (typeof rawData.length === 'number' ? rawData.length : text.length) as number;
    const truncated = rawData.truncated === true;
    const url = typeof rawData.url === 'string' ? rawData.url : undefined;
    const title = typeof rawData.title === 'string' ? rawData.title : undefined;
    const textRuns = Array.isArray(rawData.textRuns) ? rawData.textRuns
      : Array.isArray(rawData.runs) ? rawData.runs
      : undefined;

    return {
      ok: true,
      summary: truncated
        ? `页面文本: 获取到 ${length}+ 个字符（已截断）`
        : `页面文本: 获取到 ${length} 个字符（完整文本）`,
      text,
      length,
      truncated,
      url,
      title,
      textRuns,
    };
  },
};

/**
 * 获取当前页面的可见文本内容
 */
export async function getText(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<GetTextData>> {
  return runCommand(def, args, client);
}
