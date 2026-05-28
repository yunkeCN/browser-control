#!/usr/bin/env node
/**
 * Browser Control CLI — 通过 Controller 层执行命令，输出 CommandResult 格式
 *
 * 用法: browser-control <command> [--args <json>]
 */
import fs from 'node:fs';
import { navigate } from './commands/navigate.js';
import { snapshot } from './commands/snapshot.js';
import { click } from './commands/click.js';
import { fill } from './commands/fill.js';
import { press } from './commands/press.js';
import { scroll } from './commands/scroll.js';
import { upload } from './commands/upload.js';
import { getText } from './commands/get-text.js';
import { capture } from './commands/capture.js';
import { evaluate } from './commands/evaluate.js';
import { waitFor } from './commands/wait-for.js';
import { network } from './commands/network.js';
import { tabs } from './commands/tabs.js';
import { closeSession } from './commands/session.js';
import { download } from './commands/download.js';
import { DaemonClient } from '../mcp/daemon-client.js';
import { startDaemonProcess, stopDaemonProcess } from '../daemon/process-manager.js';

/** Controller 命令分发表 */
const DISPATCH: Record<string, (args: Record<string, unknown>, client: DaemonClient) => Promise<unknown>> = {
  navigate, snapshot, click, fill, press, scroll, upload,
  get_text: getText, capture, evaluate, wait_for: waitFor,
  network,
  tabs,
  close_session: closeSession,
  download,
};

function printHelp(): void {
  console.log(`Browser Control CLI

用法: browser-control <command> [--session <name>] [--args <json>] [--args-file <path>] [--code-file <path>] [--timeout-ms <ms>] [--id <id>] [--json]

命令: ${Object.keys(DISPATCH).join(', ')}

诊断:
  start     启动 daemon
  stop      停止 daemon
  restart   重启 daemon
  status    查看 daemon 状态
  doctor    运行 daemon 诊断

示例:
  browser-control navigate --session demo --args '{"url":"https://example.com"}'
  browser-control click --session demo --args '{"target":"@eyws8mg_1"}'
  browser-control click --session demo --args '{"text":"新增分支","x":200,"y":300}'
  browser-control evaluate --session demo --code-file ./snippet.js
  browser-control status
`);
}

function failArgParse(summary: string): never {
  console.error(JSON.stringify({ ok: false, summary }));
  process.exit(1);
}

function requireFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    failArgParse(`${flag} 需要一个参数值`);
  }
  return value;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      failArgParse(`${label} 必须是 JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      failArgParse(`${label} 必须是有效的 JSON`);
    }
    throw err;
  }
}

function parseArgs(argv: string[]): { command: string; args: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  const envelopeArgs: Record<string, unknown> = {};
  let inlineArgs: Record<string, unknown> | undefined;
  let fileArgs: Record<string, unknown> | undefined;
  let codeFile: string | undefined;
  let command = '';

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      printHelp();
      process.exit(0);
    }
    if (!command && !argv[i].startsWith('--')) {
      command = argv[i];
    } else if (argv[i] === '--args') {
      const value = requireFlagValue(argv, i, '--args');
      inlineArgs = parseJsonObject(value, '--args');
      i += 1;
    } else if (argv[i] === '--args-file') {
      const filePath = requireFlagValue(argv, i, '--args-file');
      try {
        fileArgs = parseJsonObject(fs.readFileSync(filePath, 'utf8'), '--args-file');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code) {
          failArgParse(`读取 --args-file 失败: ${(err as Error).message}`);
        }
        throw err;
      }
      i += 1;
    } else if (argv[i] === '--code-file') {
      codeFile = requireFlagValue(argv, i, '--code-file');
      i += 1;
    } else if (argv[i] === '--session') {
      envelopeArgs.session = requireFlagValue(argv, i, '--session');
      i += 1;
    } else if (argv[i] === '--id') {
      envelopeArgs.id = requireFlagValue(argv, i, '--id');
      i += 1;
    } else if (argv[i] === '--timeout-ms') {
      const value = Number(requireFlagValue(argv, i, '--timeout-ms'));
      if (!Number.isFinite(value) || value <= 0) {
        failArgParse('--timeout-ms 必须是正数');
      }
      envelopeArgs.timeoutMs = value;
      i += 1;
    } else if (argv[i] === '--json') {
      // Controller commands already print JSON. Keep --json accepted for consistency with lifecycle commands.
    } else if (argv[i].startsWith('--')) {
      failArgParse(`未知参数: ${argv[i]}`);
    }
  }

  if (codeFile !== undefined && command !== 'evaluate') {
    failArgParse('--code-file 只能用于 evaluate 命令');
  }

  Object.assign(args, fileArgs, inlineArgs, envelopeArgs);
  if (codeFile !== undefined) {
    try {
      args.code = fs.readFileSync(codeFile, 'utf8');
    } catch (err: unknown) {
      failArgParse(`读取 --code-file 失败: ${(err as Error).message}`);
    }
  }

  return { command, args };
}

/** 生命周期/诊断命令：直连 daemon 并打印原始 JSON */
async function runLifecycleCommand(command: string): Promise<void> {
  if (command === 'start') {
    const result = await startDaemonProcess();
    console.log(JSON.stringify({
      ...result,
      summary: result.ok
        ? result.action === 'alreadyRunning'
          ? `Browser Control daemon already running on port ${result.port}`
          : `Browser Control daemon started on port ${result.port}`
        : `Browser Control daemon failed to start: ${result.error || 'unknown error'}`,
    }, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (command === 'stop') {
    const result = await stopDaemonProcess();
    console.log(JSON.stringify({
      ...result,
      summary: result.ok
        ? result.action === 'notRunning'
          ? 'Browser Control daemon is not running'
          : 'Browser Control daemon stopped'
        : `Browser Control daemon failed to stop: ${result.error || 'unknown error'}`,
    }, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (command === 'restart') {
    const stopped = await stopDaemonProcess();
    if (!stopped.ok) {
      console.log(JSON.stringify({
        ok: false,
        action: 'failed',
        port: stopped.port,
        error: stopped.error,
        summary: `Browser Control daemon failed to stop before restart: ${stopped.error || 'unknown error'}`,
      }, null, 2));
      process.exit(1);
    }
    const started = await startDaemonProcess();
    console.log(JSON.stringify({
      ...started,
      action: started.ok ? 'restarted' : 'failed',
      stopped: stopped.action,
      summary: started.ok
        ? `Browser Control daemon restarted on port ${started.port}`
        : `Browser Control daemon failed to restart: ${started.error || 'unknown error'}`,
    }, null, 2));
    if (!started.ok) process.exit(1);
    return;
  }

  const http = await import('node:http');
  const HOST = process.env.BROWSER_CONTROL_HOST || '127.0.0.1';
  const PORT = Number(process.env.BROWSER_CONTROL_PORT || 10087);
  const urlPath = command === 'status' ? '/status' : command === 'doctor' ? '/health' : '';

  if (!urlPath) {
    console.log(JSON.stringify({ ok: false, summary: `未知命令: "${command}"`, data: null }));
    process.exit(1);
  }

  try {
    const data = await new Promise<any>((resolve, reject) => {
      const req = http.get(`http://${HOST}:${PORT}${urlPath}`, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ok: false, summary: `连接 daemon 失败: ${msg}` }));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv);

  if (!command) {
    printHelp();
    process.exit(1);
  }

  // 生命周期命令
  if (command === 'start' || command === 'stop' || command === 'restart' || command === 'status' || command === 'doctor') {
    return runLifecycleCommand(command);
  }

  const handler = DISPATCH[command];
  if (!handler) {
    console.log(JSON.stringify({
      ok: false,
      summary: `未知命令: "${command}"`,
      data: null,
      nextSteps: [`可用命令: ${Object.keys(DISPATCH).join(', ')}`],
    }));
    process.exit(1);
  }

  const client = new DaemonClient();
  try {
    const result = await handler(args, client);
    console.log(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ok: false, summary: `CLI 执行异常: ${message}` }));
    process.exit(1);
  }
}

main();
