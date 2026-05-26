/**
 * 保存为 PDF 命令 — save_as_pdf
 *
 * 功能: 将当前页面保存为 PDF 文件
 * 使用场景: 页面存档、打印、分享
 *
 * 设计要点:
 * - 支持 A4 和 Letter 两种纸张格式
 * - 支持横/纵向、缩放、背景打印等选项
 * - 支持自定义文件名
 * - daemon 错误时提供 nextSteps 建议
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** save_as_pdf 命令的输入参数 */
export interface SaveAsPdfInput {
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
  /** 纸张格式（可选，默认 A4） */
  paperFormat?: 'A4' | 'Letter';
  /** 是否横向打印（可选，默认 false） */
  landscape?: boolean;
  /** 缩放比例（可选，默认 1.0） */
  scale?: number;
  /** 是否打印背景（可选，默认 true） */
  printBackground?: boolean;
  /** 自定义文件名（可选，默认由 daemon 生成） */
  fileName?: string;
}

/** save_as_pdf 命令的输出数据 */
export interface SaveAsPdfData {
  /** PDF 文件的保存路径 */
  filePath: string;
  /** PDF 文件名 */
  fileName: string;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const def: CommandDefinition<SaveAsPdfInput, SaveAsPdfData> = {
  name: 'save_as_pdf',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): SaveAsPdfInput => {
    const validKeys = ['tabId', 'paperFormat', 'landscape', 'scale', 'printBackground', 'fileName'];
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
      args.paperFormat !== undefined &&
      !['A4', 'Letter'].includes(args.paperFormat as string)
    ) {
      throw new Error('paperFormat 必须是 A4 或 Letter');
    }
    if (args.landscape !== undefined && typeof args.landscape !== 'boolean') {
      throw new Error('landscape 必须是布尔值');
    }
    if (args.scale !== undefined && typeof args.scale !== 'number') {
      throw new Error('scale 必须是数字');
    }
    if (args.printBackground !== undefined && typeof args.printBackground !== 'boolean') {
      throw new Error('printBackground 必须是布尔值');
    }
    if (args.fileName !== undefined && typeof args.fileName !== 'string') {
      throw new Error('fileName 必须是字符串');
    }
    return args as unknown as SaveAsPdfInput;
  },

  execute: async (
    input: SaveAsPdfInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope(
      'save_as_pdf',
      input as unknown as Record<string, unknown>,
    );
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  toResult: (raw: Record<string, unknown>): CommandResult<SaveAsPdfData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData || typeof rawData.filePath !== 'string') {
      return {
        ok: false,
        summary: '保存 PDF 失败: daemon 未返回文件路径',
        nextSteps: ['请确认当前标签页存在', '重试 save_as_pdf 命令'],
      };
    }

    const filePath = rawData.filePath as string;
    const fileName = (rawData.fileName as string) || filePath.split('/').pop() || 'output.pdf';

    return {
      ok: true,
      summary: `PDF 已保存到 ${filePath}`,
      data: {
        filePath,
        fileName,
      },
    };
  },
};

/**
 * 将当前页面保存为 PDF 文件
 */
export async function saveAsPdf(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<SaveAsPdfData>> {
  return runCommand(def, args, client);
}
