/**
 * 统一视觉导出命令 — capture
 *
 * 通过 format 参数区分输出格式:
 * - format: 'png' (默认) / 'jpeg' — 截图
 * - format: 'pdf' — 保存为 PDF
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

export type CaptureFormat = 'png' | 'jpeg' | 'pdf';

export interface CaptureInput {
  format?: CaptureFormat;
  tabId?: number;
  fileName?: string;
  // screenshot 参数
  quality?: number;
  // pdf 参数
  paperFormat?: 'A4' | 'Letter';
  landscape?: boolean;
  scale?: number;
  printBackground?: boolean;
}

export interface CaptureData {
  filePath: string;
  format: CaptureFormat;
  fileName?: string;
}

// ─── 命令定义 ────────────────────────────────────────────────────

const captureDef: CommandDefinition<CaptureInput, CaptureData> = {
  name: 'capture',
  requiredArgs: [],

  validate: (args: Record<string, unknown>): CaptureInput => {
    const format = (args.format as string | undefined) || 'png';
    if (!['png', 'jpeg', 'pdf'].includes(format)) {
      throw new Error('format 必须是 "png"、"jpeg" 或 "pdf"');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }
    if (args.fileName !== undefined && typeof args.fileName !== 'string') {
      throw new Error('fileName 必须是字符串');
    }
    if (args.quality !== undefined && typeof args.quality !== 'number') {
      throw new Error('quality 必须是数字');
    }
    if (args.paperFormat !== undefined && !['A4', 'Letter'].includes(args.paperFormat as string)) {
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
    return {
      format: format as CaptureFormat,
      tabId: args.tabId as number | undefined,
      fileName: args.fileName as string | undefined,
      quality: args.quality as number | undefined,
      paperFormat: args.paperFormat as 'A4' | 'Letter' | undefined,
      landscape: args.landscape as boolean | undefined,
      scale: args.scale as number | undefined,
      printBackground: args.printBackground as boolean | undefined,
    };
  },

  execute: async (
    input: CaptureInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const format = input.format || 'png';

    if (format === 'pdf') {
      const envelope = daemon.buildEnvelope('save_as_pdf', {
        tabId: input.tabId,
        paper_format: input.paperFormat,
        landscape: input.landscape,
        scale: input.scale,
        print_background: input.printBackground,
        file_name: input.fileName,
      });
      const response = await daemon.command(envelope);
      return { ...response.data as Record<string, unknown>, _format: 'pdf' };
    }

    // png/jpeg
    const envelope = daemon.buildEnvelope('screenshot', {
      tabId: input.tabId,
      format,
      quality: input.quality,
      fileName: input.fileName,
    });
    const response = await daemon.command(envelope);
    return { ...response.data as Record<string, unknown>, _format: format };
  },

  toResult: (raw: Record<string, unknown>): CommandResult<CaptureData> => {
    const format = (raw._format as CaptureFormat) || 'png';
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (format === 'pdf') {
      if (!rawData || typeof rawData.filePath !== 'string') {
        return {
          ok: false,
          summary: 'PDF 保存失败: daemon 未返回文件路径',
          nextSteps: ['请确认当前标签页存在', '重试 capture 命令'],
        };
      }
      const filePath = rawData.filePath as string;
      const fileName = (rawData.fileName as string) || filePath.split('/').pop() || 'output.pdf';
      return {
        ok: true,
        summary: `PDF 已保存到 ${filePath}`,
        filePath, format: 'pdf' as CaptureFormat, fileName,
      };
    }

    // png/jpeg
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
        nextSteps: ['请确认当前标签页存在', '重试 capture 命令'],
      };
    }

    return {
      ok: true,
      summary: `截图已保存到 ${filePath}`,
      filePath, format: format as CaptureFormat,
    };
  },
};

export async function capture(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<CaptureData>> {
  return runCommand(captureDef, args, client);
}
