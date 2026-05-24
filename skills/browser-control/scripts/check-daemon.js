#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultBrowserControlHome, defaultDaemonUrl, httpJson, joinUrl, printJson } = require('./support');

function usage() {
  console.log('Usage: check-daemon.js [--json]\nCheck if the Browser Control daemon is running.');
}

function readPid(pidFile) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  let json = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      usage();
      return;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }

  const pidFile = path.join(defaultBrowserControlHome(), 'daemon.pid');
  const pid = readPid(pidFile);
  const pidRunning = pid ? isProcessRunning(pid) : false;
  const daemonUrl = defaultDaemonUrl();
  let httpHealthy = false;
  let httpStatus = null;
  try {
    const response = await httpJson(joinUrl(daemonUrl, 'health'), { timeout: 2000 });
    httpStatus = response.status;
    httpHealthy = response.status === 200 && response.data?.running === true;
  } catch {}

  const running = pidRunning || httpHealthy;
  const data = { running, pid: pid ? String(pid) : '', pidRunning, httpHealthy, httpStatus, pidFile, daemonUrl };

  if (json) {
    printJson(data);
  } else {
    console.log('Browser Control Daemon Check');
    console.log('==========================');
    console.log(`Running: ${running ? 'YES' : 'NO'}`);
    console.log(`PID: ${pid || 'unknown'}`);
    console.log(`PID alive: ${pidRunning ? 'yes' : 'no'}`);
    console.log(`HTTP healthy: ${httpHealthy ? 'yes' : 'no'}`);
    if (!running) {
      console.log('');
      console.log('Start the daemon with: browser-control start');
    }
  }

  process.exit(running ? 0 : 1);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
