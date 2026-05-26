#!/usr/bin/env node
/**
 * Browser Control CLI — 通过 Controller 层执行命令，输出 CommandResult 格式
 *
 * 用法: browser-control <command> [--args <json>]
 */
import { navigate } from './commands/navigate.js';
import { snapshot } from './commands/snapshot.js';
import { click } from './commands/click.js';
import { clickText } from './commands/click-text.js';
import { fill } from './commands/fill.js';
import { press } from './commands/press.js';
import { scroll } from './commands/scroll.js';
import { upload } from './commands/upload.js';
import { getText } from './commands/get-text.js';
import { screenshot } from './commands/screenshot.js';
import { evaluate } from './commands/evaluate.js';
import { waitFor } from './commands/wait-for.js';
import { observeStart, observeDiff } from './commands/observe.js';
import { networkStart, networkList, networkDetail, networkStop } from './commands/network.js';
import { listTabs, findTab, closeTab } from './commands/tabs.js';
import { closeSession } from './commands/session.js';
import { clickProbe } from './commands/click-probe.js';
import { saveAsPdf } from './commands/save-as-pdf.js';
import { download } from './commands/download.js';
import { DaemonClient } from '../mcp/daemon-client.js';

/** Controller 命令分发表 */
const DISPATCH: Record<string, (args: Record<string, unknown>, client: DaemonClient) => Promise<unknown>> = {
  navigate, snapshot, click, click_text: clickText, fill, press, scroll, upload,
  get_text: getText, screenshot, evaluate, wait_for: waitFor,
  observe_start: observeStart, observe_diff: observeDiff,
  network_start: networkStart, network_list: networkList,
  network_detail: networkDetail, network_stop: networkStop,
  list_tabs: listTabs, find_tab: findTab, close_tab: closeTab,
  close_session: closeSession,
  click_probe: clickProbe, save_as_pdf: saveAsPdf, download,
};

function printHelp(): void {
  console.log(`Browser Control CLI

用法: browser-control <command> [--args <json>]

命令: ${Object.keys(DISPATCH).join(', ')}

诊断:
  status    查看 daemon 状态
  doctor    运行 daemon 诊断

示例:
  browser-control navigate --args '{"url":"https://example.com"}'
  browser-control click --args '{"target":"@eyws8mg_1"}'
  browser-control click_text --args '{"text":"新增分支"}'
  browser-control status
`);
}

function parseArgs(argv: string[]): { command: string; args: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  let command = '';

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      printHelp();
      process.exit(0);
    }
    if (!command && !argv[i].startsWith('--')) {
      command = argv[i];
    } else if (argv[i] === '--args' && i + 1 < argv.length) {
      try {
        Object.assign(args, JSON.parse(argv[++i]));
      } catch {
        console.error(JSON.stringify({ ok: false, summary: '--args 必须是有效的 JSON' }));
        process.exit(1);
      }
    }
  }

  return { command, args };
}

/** 生命周期/诊断命令：直连 daemon 并打印原始 JSON */
async function runLifecycleCommand(command: string): Promise<void> {
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
  if (command === 'status' || command === 'doctor') {
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
