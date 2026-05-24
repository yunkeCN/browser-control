#!/usr/bin/env node
'use strict';

const { chromeUserDataDir, detectLoadedExtension, detectLoadedExtensions, printJson } = require('./support');

function usage() {
  console.log(`Usage: check-extension.js [--json]

Check if the Browser Control Chrome Extension is installed and enabled.`);
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

  const matches = detectLoadedExtensions();
  const extension = matches[0] || detectLoadedExtension();
  const data = {
    ...extension,
    chromeUserDataDir: chromeUserDataDir(),
    installedProfileCount: matches.length,
    installedProfiles: matches
  };

  if (args.json) {
    printJson(data);
  } else {
    console.log('Browser Control Extension Check');
    console.log('=====================================');
    console.log(`Chrome user data: ${chromeUserDataDir()}`);
    console.log(`Extension ID: ${extension.extensionId}`);
    console.log(`Installed: ${matches.length ? 'YES' : 'NO'}`);
    if (matches.length) {
      for (const match of matches) {
        console.log('');
        console.log(`Profile: ${match.profileName} (${match.profilePath})`);
        console.log(`State: ${match.state ?? 'unknown'}`);
        console.log(`Version: ${match.manifestVersion || 'unknown'}`);
        if (match.loadedPath) console.log(`Path: ${match.loadedPath}`);
      }
    } else {
      console.log(`Profile checked first: ${extension.profilePath}`);
      console.log('');
      console.log("Install the extension from chrome://extensions/ using 'Load unpacked'.");
    }
  }

  process.exit(matches.length ? 0 : 2);
}

main();
