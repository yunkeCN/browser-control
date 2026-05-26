/**
 * 截图命令 — screenshot
 *
 * 功能: 对当前页面进行截图
 * 使用场景: 截图保存、页面视觉验证、分享页面状态
 *
 * 设计要点:
 * - 支持 PNG 和 JPEG 两种格式
 * - 支持自定义文件名
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** screenshot 命令的输入参数 */
export interface ScreenshotInput {
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 截图格式（可选，默认 png） */
  format?: 'png' | 'jpeg';
  /** JPEG 图片质量 0-100（可选，仅 format=jpeg 时生效） */
  quality?: number;
  /** 自定义文件名（可选，默认由 daemon 生成） */
  fileName?: string;
}

/** screenshot 命令的输出数据 */
export interface ScreenshotData {
  /** 截图文件的保存路径 */
  filePath: string;
  /** 截图格式 */
  format: 'png' | 'jpeg';
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<ScreenshotInput, ScreenshotData> = {
  name: 'screenshot',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): ScreenshotInput => {
    const validKeys = ['tabId', 'format', 'quality', 'fileName'];
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
      args.format !== undefined &&
      !['png', 'jpeg'].includes(args.format as string)
    ) {
      throw new Error('format 必须是 png 或 jpeg');
    }
    if (args.quality !== undefined && typeof args.quality !== 'number') {
      throw new Error('quality 必须是数字');
    }
    if (args.fileName !== undefined && typeof args.fileName !== 'string') {
      throw new Error('fileName 必须是字符串');
    }
    return args as unknown as ScreenshotInput;
  },

  execute: async (
    input: ScreenshotInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'screenshot',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<ScreenshotData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    // daemon 将截图保存在 data.artifact.path（通过 extractArtifacts）
    const filePath =
      (rawData?.artifact as Record<string, unknown> | undefined)?.path as string |
        undefined ||
      (raw.artifacts as Array<Record<string, unknown>> | undefined)?.[0]?.path as
        | string
        | undefined;

    if (!filePath) {
      return {
        ok: false,
        summary: '截图失败: daemon 未返回截图数据',
        nextSteps: ['请确认当前标签页存在', '重试 screenshot 命令'],
      };
    }
    const format = (rawData.format as string) || 'png';

    return {
      ok: true,
      summary: `截图已保存到 ${filePath}`,
      data: {
        filePath,
        format: format as 'png' | 'jpeg',
      },
    };
  },
};

/**
 * 对当前页面进行截图
 */
export async function screenshot(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<ScreenshotData>> {
  return runCommand(def, args, client);
}
