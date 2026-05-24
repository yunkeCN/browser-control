#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromeUserDataDir, detectLoadedExtension, findChrome, findChromeProfile, printJson } = require('./support');

function usage() {
  console.log(`Usage: open-chrome.js [--dry-run] [--json] [--profile <directory>]

Open a Chrome window for the Chrome profile that has Browser Control installed.
Useful when the daemon cannot connect to the extension.`);
}

function parseArgs(argv) {
  const parsed = { dryRun: false, json: false, profile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--profile') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--profile requires a profile directory name');
      parsed.profile = value;
      i += 1;
    }
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function selectProfile(userData, profileName = null) {
  if (profileName) return { name: profileName, path: path.join(userData, profileName), userData, source: 'argument' };
  const loaded = detectLoadedExtension({ userData });
  if (loaded.installed) {
    return { name: loaded.profileName, path: loaded.profilePath, userData, source: 'extension' };
  }
  return { ...findChromeProfile(userData), source: 'active' };
}

function commandPreview(chromePath, profileName) {
  if (process.platform === 'darwin' && chromePath.endsWith('.app')) {
    return ['open', '-n', '-a', chromePath, '--args', `--profile-directory=${profileName}`, '--new-window', 'about:blank'];
  }
  return [chromePath, `--profile-directory=${profileName}`, '--new-window', 'about:blank'];
}

function launchChrome(chromePath, profileName) {
  const command = commandPreview(chromePath, profileName);
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' });
  child.unref();
}

function main() {
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

  const chrome = findChrome();
  if (!chrome) {
    console.error('Error: Google Chrome or Chromium not found.');
    process.exit(1);
  }
  const userData = chromeUserDataDir();
  const profile = selectProfile(userData, args.profile);
  const command = commandPreview(chrome, profile.name);

  if (args.json) {
    printJson({ chrome, profileDirectory: profile.name, profilePath: profile.path, profileSource: profile.source, dryRun: args.dryRun, command });
    return;
  }

  console.log(`Opening Chrome (profile: ${profile.name})...`);
  if (args.dryRun) {
    console.log(`[DRY RUN] Would run: ${command.map(part => JSON.stringify(part)).join(' ')}`);
    return;
  }
  launchChrome(chrome, profile.name);
  console.log('Chrome launched. Wait a moment for the extension to connect.');
}

main();
