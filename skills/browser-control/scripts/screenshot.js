#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultDaemonUrl, httpJson, joinUrl } = require('./support');

const DEFAULT_OUTPUT_DIR = process.env.BROWSER_CONTROL_SCREENSHOT_DIR || path.join(os.tmpdir(), 'browser-control-screenshots');

function usage() {
  console.log(`Usage: screenshot.js [OPTIONS]

Take a browser screenshot via the Browser Control Daemon.

Options:
  -o PATH      Output file path (default: ${DEFAULT_OUTPUT_DIR}/{timestamp}.{ext})
  -s SESSION   Browser session name
  -t TAB_ID    Specific tab ID to screenshot
  -f FORMAT    Image format: png or jpeg (default: png)
  -q QUALITY   JPEG quality 0-100 (jpeg only)
  -d URL       Daemon URL (default: ${defaultDaemonUrl()})
  -p           Request full-page screenshot (current extension backend returns viewport capture with a note)
  -h           Show this help

Output:
  Prints the path to the saved screenshot file on stdout.
  All diagnostic messages go to stderr.`);
}

function trace(message) {
  console.error(`[screenshot] ${message}`);
}

function readOption(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const parsed = {
    daemonUrl: defaultDaemonUrl(),
    outputPath: '',
    session: '',
    tabId: '',
    format: 'png',
    quality: '',
    fullPage: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '-p') parsed.fullPage = true;
    else if (arg === '-o') { parsed.outputPath = readOption(argv, i, arg); i += 1; }
    else if (arg === '-s') { parsed.session = readOption(argv, i, arg); i += 1; }
    else if (arg === '-t') { parsed.tabId = readOption(argv, i, arg); i += 1; }
    else if (arg === '-f') { parsed.format = readOption(argv, i, arg); i += 1; }
    else if (arg === '-q') { parsed.quality = readOption(argv, i, arg); i += 1; }
    else if (arg === '-d') { parsed.daemonUrl = readOption(argv, i, arg); i += 1; }
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function outputPathFor(format, outputPath) {
  if (outputPath) return path.resolve(process.cwd(), outputPath);
  const ext = format === 'jpeg' ? 'jpg' : format;
  return path.join(DEFAULT_OUTPUT_DIR, `${timestamp()}.${ext}`);
}

function findArtifactPath(envelope) {
  return envelope?.data?.artifact?.path || envelope?.artifacts?.[0]?.path || '';
}

function findImageData(envelope) {
  const value = envelope?.data?.data || envelope?.data?.image || '';
  return typeof value === 'string' && value.length > 0 ? value : '';
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    trace(`Error: ${err.message}`);
    usage();
    process.exit(2);
  }
  if (args.help) {
    usage();
    return;
  }
  if (!['png', 'jpeg'].includes(args.format)) {
    trace(`Error: format must be png or jpeg, got: ${args.format}`);
    process.exit(2);
  }

  const requestArgs = { format: args.format };
  if (args.tabId) requestArgs.tabId = Number.isFinite(Number(args.tabId)) ? Number(args.tabId) : args.tabId;
  if (args.fullPage) requestArgs.fullPage = true;
  if (args.quality && args.format === 'jpeg') requestArgs.quality = Number(args.quality);
  const body = { command: 'screenshot', args: requestArgs };
  if (args.session) body.session = args.session;

  trace(`Requesting screenshot (format=${args.format}, session=${args.session || 'default'})...`);
  let response;
  try {
    response = await httpJson(joinUrl(args.daemonUrl, 'command'), { method: 'POST', body, timeout: 30000 });
  } catch (err) {
    trace(`Error: request failed: ${err.message}`);
    process.exit(1);
  }
  if (response.status !== 200 || response.data?.ok === false) {
    const message = response.data?.error?.message || response.data?.error || `HTTP ${response.status}`;
    trace(`Error: daemon returned status ${response.status}: ${message}`);
    process.exit(1);
  }

  const targetPath = outputPathFor(args.format, args.outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const artifactPath = findArtifactPath(response.data);
  if (artifactPath && fs.existsSync(artifactPath)) {
    if (path.resolve(artifactPath) !== path.resolve(targetPath)) fs.copyFileSync(artifactPath, targetPath);
    const fileSize = fs.statSync(targetPath).size;
    trace(`Screenshot saved: ${targetPath}`);
    trace(`  Source artifact: ${artifactPath}`);
    trace(`  File size: ${fileSize} bytes`);
    console.log(targetPath);
    return;
  }

  const imageData = findImageData(response.data);
  if (!imageData) {
    trace('Error: could not extract image data from response');
    if (artifactPath) {
      trace(`Artifact path is not readable from this process: ${artifactPath}`);
      trace('Run the helper in the same OS environment as the daemon, or set BROWSER_CONTROL_ARTIFACT_DIR to a shared path.');
    }
    process.exit(1);
  }

  fs.writeFileSync(targetPath, Buffer.from(imageData, 'base64'));
  const fileSize = fs.statSync(targetPath).size;
  trace(`Screenshot saved: ${targetPath}`);
  trace(`  Data received: ${imageData.length} chars base64`);
  trace(`  File size: ${fileSize} bytes`);
  console.log(targetPath);
}

main().catch(err => {
  trace(`Error: ${err.message}`);
  process.exit(1);
});
