#!/usr/bin/env node
'use strict';

const { defaultDaemonUrl, httpJson, joinUrl, printJson } = require('./support');

function usage() {
  console.log(`Usage: health-check.js [--json]

Check the health of the Browser Control system.

Options:
  --json    Output results as JSON
  -h        Show this help

Exit codes:
  0  All systems healthy
  1  Daemon not running or unhealthy
  2  Extension not connected
  3  Unknown error`);
}

function parseArgs(argv) {
  const parsed = { json: false };
  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(3);
  }
  if (args.help) {
    usage();
    return;
  }

  const daemonUrl = defaultDaemonUrl();
  let response;
  try {
    response = await httpJson(joinUrl(daemonUrl, 'health'), { timeout: 3000 });
  } catch (err) {
    const data = { running: false, healthy: false, daemonUrl, error: 'Daemon not reachable', details: err.message };
    if (args.json) printJson(data);
    else {
      console.log('Browser Control Health Check');
      console.log('==================================');
      console.log('Daemon: NOT RUNNING');
      console.log(`URL: ${daemonUrl}`);
      console.log('');
      console.log('Start the daemon with: browser-control start');
    }
    process.exit(1);
  }

  if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
    const data = { running: true, healthy: false, daemonUrl, httpStatus: response.status };
    if (args.json) printJson(data);
    else console.log(`Daemon returned HTTP ${response.status}`);
    process.exit(1);
  }

  const data = response.data;
  const running = data.running === true;
  const extensionConnected = data.extensionConnected === true || data.extension_connected === true;
  if (args.json) {
    printJson(data);
  } else {
    const port = (() => {
      try { return new URL(daemonUrl).port || '80'; } catch { return '10087'; }
    })();
    console.log('Browser Control Health Check');
    console.log('==================================');
    console.log('Daemon: RUNNING');
    console.log(`Version: ${data.version || 'unknown'}`);
    console.log(`Port: ${data.port || port}`);
    console.log(`Uptime: ${data.uptimeSeconds || data.uptime_seconds || 0}s`);
    console.log(`Extension: ${extensionConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
    console.log('');
    if (extensionConnected) {
      console.log('All systems healthy.');
    } else {
      console.log('The Chrome Extension is not connected.');
      console.log('Ensure Chrome is running and the Browser Control extension is installed and enabled.');
    }
  }

  if (!running) process.exit(1);
  if (!extensionConnected) process.exit(2);
}

main().catch(err => {
  console.error(err.message);
  process.exit(3);
});
