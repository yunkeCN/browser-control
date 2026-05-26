/**
 * 上传命令 — upload
 *
 * 功能: 将本地文件上传到页面元素（如文件选择器）
 * 使用场景: 上传文件到网页表单、附件等
 *
 * 设计要点:
 * - 参数验证使用简单的手动检查（不使用 Zod schema）
 * - target 必须是 @e<structureId>_<revision> 引用或 css=<selector> 选择器
 * - files 必须是非空字符串数组（文件绝对路径）
 * - 成功返回 LLM-friendly 的 summary + 结构化 data
 */

import type { DaemonClient } from '../../mcp/daemon-client';
import type { CommandResult } from '../types';
import { runCommand, type CommandDefinition } from '../runner';

// ─── 类型定义 ────────────────────────────────────────────────────

/** upload 命令的输入参数 */
export interface UploadInput {
  /** 目标元素引用（必填，@e 引用或 css= 选择器） */
  target: string;
  /** 文件绝对路径数组（必填） */
  files: string[];
  /** 标签页 ID（可选，默认使用当前活跃标签页） */
  tabId?: number;
}

/** upload 命令的输出数据 */
export interface UploadData {
  /** 是否成功上传 */
  uploaded: boolean;
  /** 上传的文件数量 */
  fileCount: number;
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

const def: CommandDefinition<UploadInput, UploadData> = {
  name: 'upload',
  requiredArgs: ['target', 'files'],

  /**
   * 参数验证
   * 使用简单的手动检查：
   * - target 不能为空，且必须以 @e 或 css= 开头
   * - files 必须是非空字符串数组
   */
  validate: (args: Record<string, unknown>): UploadInput => {
    if (!isValidTarget(args.target)) {
      throw new Error(
        'target 必须是 @e<structureId>_<revision> 引用或 css=<selector> 选择器',
      );
    }

    if (!Array.isArray(args.files)) {
      throw new Error('files 必须是字符串数组');
    }
    if (args.files.length === 0) {
      throw new Error('files 不能为空数组');
    }
    if (!args.files.every((f) => typeof f === 'string')) {
      throw new Error('files 中的每个元素必须是字符串（文件绝对路径）');
    }
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId 必须是数字');
    }

    return {
      target: args.target as string,
      files: args.files as string[],
      tabId: args.tabId as number | undefined,
    };
  },

  /**
   * 执行上传
   * 通过 DaemonClient 向 daemon 发送 upload 命令
   */
  execute: async (
    input: UploadInput,
    daemon: DaemonClient,
  ): Promise<Record<string, unknown>> => {
    const envelope = daemon.buildEnvelope('upload', input as unknown as Record<string, unknown>);
    const response = await daemon.command(envelope);
    return response.data as Record<string, unknown>;
  },

  /**
   * 将 daemon 响应转换为 LLM-friendly 格式
   * - 提取 daemon 返回的业务数据
   * - 生成包含目标元素和文件数量的摘要
   */
  toResult: (raw: Record<string, unknown>): CommandResult<UploadData> => {
    const rawData = raw.data as Record<string, unknown> | undefined;

    if (!rawData) {
      return {
        ok: false,
        summary: '上传失败: daemon 未返回上传结果',
        nextSteps: ['请确认目标元素仍存在于页面中', '重试 upload 命令'],
      };
    }

    const uploaded = Boolean(rawData.uploaded);
    const fileCount = Number(rawData.fileCount) || 0;
    const target = String(rawData.target || '');

    if (!uploaded) {
      return {
        ok: false,
        summary: '上传未生效: 文件可能被目标元素拒绝',
        nextSteps: ['请确认目标元素支持文件上传', '检查文件路径是否正确'],
      };
    }

    return {
      ok: true,
      summary: `已上传 ${fileCount} 个文件到元素 ${target}`,
      data: {
        uploaded: true,
        fileCount,
      },
    };
  },
};

/**
 * 将本地文件上传到页面元素（可通过 CommandRunner 直接调用）
 */
export async function upload(
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<CommandResult<UploadData>> {
  return runCommand(def, args, client);
}
