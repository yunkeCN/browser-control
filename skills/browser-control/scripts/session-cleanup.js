#!/usr/bin/env node
'use strict';

const { defaultDaemonUrl, httpJson, joinUrl } = require('./support');

function usage() {
  console.log(`Usage: session-cleanup.js [OPTIONS]

Close idle browser sessions and their tabs.

Options:
  --dry-run        List idle sessions without closing them
  --max-idle N     Maximum idle time in minutes (default: 30)
  -n N             Alias for --max-idle
  -d URL           Daemon URL (default: ${defaultDaemonUrl()})
  -h               Show this help`);
}

function readOption(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const parsed = {
    daemonUrl: defaultDaemonUrl(),
    maxIdleMinutes: Number(process.env.BROWSER_CONTROL_MAX_IDLE || 30),
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '-d') { parsed.daemonUrl = readOption(argv, i, arg); i += 1; }
    else if (arg === '-n' || arg === '--max-idle') {
      parsed.maxIdleMinutes = Number(readOption(argv, i, arg));
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(parsed.maxIdleMinutes) || parsed.maxIdleMinutes < 0) {
    throw new Error('--max-idle must be a non-negative number');
  }
  return parsed;
}

function idleMinutes(session) {
  if (!session.lastActivity) return 0;
  const last = Date.parse(session.lastActivity);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, Math.floor((Date.now() - last) / 60000));
}

async function closeSession(daemonUrl, name) {
  return httpJson(joinUrl(daemonUrl, 'command'), {
    method: 'POST',
    body: { command: 'close_session', args: {}, session: name },
    timeout: 30000
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(2);
  }
  if (args.help) {
    usage();
    return;
  }

  let status;
  try {
    status = await httpJson(joinUrl(args.daemonUrl, 'status'), { timeout: 5000 });
  } catch (err) {
    console.error(`Error: Cannot reach daemon at ${args.daemonUrl}: ${err.message}`);
    process.exit(1);
  }
  const sessions = Array.isArray(status.data?.sessions) ? status.data.sessions : [];
  if (!sessions.length) {
    console.log('No active sessions.');
    return;
  }

  console.log(`Checking sessions (max idle: ${args.maxIdleMinutes}min)...`);
  console.log('');

  for (const session of sessions) {
    const name = session.name || 'default';
    const idle = idleMinutes(session);
    const tabCount = session.tabCount || 0;
    if (idle >= args.maxIdleMinutes) {
      if (args.dryRun) {
        console.log(`[DRY RUN] Would close: ${name} (idle: ${idle}min, tabs: ${tabCount})`);
      } else {
        console.log(`Closing session: ${name} (idle: ${idle}min, tabs: ${tabCount})`);
        const response = await closeSession(args.daemonUrl, name);
        if (response.status >= 200 && response.status < 300 && response.data?.ok !== false) {
          console.log('  Closed.');
        } else {
          const message = response.data?.error?.message || response.data?.error || `HTTP ${response.status}`;
          console.error(`  Failed: ${message}`);
          process.exitCode = 1;
        }
      }
    } else {
      console.log(`Session '${name}': active (idle: ${idle}min, tabs: ${tabCount})`);
    }
  }

  console.log('');
  console.log(args.dryRun ? 'Dry run complete. Use without --dry-run to actually close sessions.' : 'Cleanup complete.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
