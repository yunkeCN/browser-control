#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function defaultBrowserControlHome() {
  return process.env.BROWSER_CONTROL_HOME || path.join(os.homedir(), '.browser-control');
}

function defaultDaemonUrl() {
  if (process.env.BROWSER_CONTROL_DAEMON_URL) return process.env.BROWSER_CONTROL_DAEMON_URL;
  const host = process.env.BROWSER_CONTROL_HOST || '127.0.0.1';
  const port = process.env.BROWSER_CONTROL_PORT || '10087';
  return `http://${host}:${port}`;
}

function defaultChromeUserDataDir(platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  return path.join(os.homedir(), '.config', 'google-chrome');
}

function chromeUserDataDir() {
  return process.env.CODEX_CHROME_USER_DATA_DIR || defaultChromeUserDataDir();
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function realPathMaybe(file) {
  try { return fs.realpathSync(file); } catch { return file || null; }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function profileHasPreferences(profilePath) {
  return fs.existsSync(path.join(profilePath, 'Preferences')) ||
    fs.existsSync(path.join(profilePath, 'Secure Preferences'));
}

function defaultChromeProfile(userData) {
  return { name: 'Default', path: path.join(userData, 'Default'), userData };
}

function listChromeProfiles(userData = chromeUserDataDir()) {
  const localState = readJsonFile(path.join(userData, 'Local State'));
  const candidates = [];
  const profile = localState?.profile || {};
  if (profile.last_used) candidates.push(profile.last_used);
  if (Array.isArray(profile.last_active_profiles)) candidates.push(...profile.last_active_profiles);
  if (profile.info_cache && typeof profile.info_cache === 'object') candidates.push(...Object.keys(profile.info_cache));
  candidates.push('Default');
  try {
    for (const entry of fs.readdirSync(userData, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profilePath = path.join(userData, entry.name);
      if (entry.name === 'Default' || /^Profile\b/.test(entry.name) || profileHasPreferences(profilePath)) {
        candidates.push(entry.name);
      }
    }
  } catch {}
  const profiles = [];
  for (const name of unique(candidates)) {
    const profilePath = path.join(userData, name);
    if (profileHasPreferences(profilePath)) {
      profiles.push({ name, path: profilePath, userData });
    }
  }
  return profiles.length ? profiles : [defaultChromeProfile(userData)];
}

function findChromeProfile(userData = chromeUserDataDir()) {
  return listChromeProfiles(userData)[0] || defaultChromeProfile(userData);
}

function chromeExecutableCandidates(platform = process.platform) {
  const envCandidates = [process.env.CHROME_PATH, process.env.GOOGLE_CHROME_SHIM].filter(Boolean);
  if (platform === 'darwin') {
    return [
      ...envCandidates,
      '/Applications/Google Chrome.app',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app'),
      '/Applications/Chromium.app'
    ];
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      ...envCandidates,
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Chromium', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Chromium', 'Application', 'chrome.exe')
    ];
  }
  return [
    ...envCandidates,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ];
}

function findChrome(platform = process.platform) {
  return chromeExecutableCandidates(platform).find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function extensionSettingMatches(ext) {
  const manifestName = ext?.manifest?.name || ext?.manifest?.short_name || '';
  const extPath = ext?.path || '';
  return /Browser Control/i.test(manifestName) || /browser-control/i.test(String(extPath));
}

function loadedFromKind(loadedPath, sourceDirs = []) {
  const loaded = realPathMaybe(loadedPath);
  const sources = sourceDirs.map(realPathMaybe).filter(Boolean);
  if (!loaded) return 'unknown';
  if (sources.some(source => loaded === source || loaded.startsWith(`${source}${path.sep}`))) return 'source';
  return 'other';
}

function extensionRecord(extensionId, ext, profile, file, options = {}) {
  let loadedPath = ext.path || null;
  if (loadedPath && !path.isAbsolute(loadedPath)) loadedPath = path.resolve(profile.path, loadedPath);
  return {
    extensionId,
    profileName: profile.name,
    profilePath: profile.path,
    preferencesFile: file,
    installed: true,
    state: ext.state ?? null,
    loadedPath,
    loadedFrom: loadedFromKind(loadedPath, options.sourceDirs || []),
    manifestName: ext.manifest?.name || null,
    manifestVersion: ext.manifest?.version || null
  };
}

function detectLoadedExtensions(options = {}) {
  const extensionId = options.extensionId || process.env.CODEX_CHROME_EXTENSION_ID || 'jfmjfhklogoienhpfnppmbcbjfjnkonk';
  const profiles = listChromeProfiles(options.userData || chromeUserDataDir());
  const exactMatches = [];
  const fallbackMatches = [];
  const seen = new Set();
  for (const profile of profiles) {
    const files = ['Secure Preferences', 'Preferences'].map(name => path.join(profile.path, name));
    for (const file of files) {
      const data = readJsonFile(file);
      const settings = data?.extensions?.settings || {};
      const ext = settings[extensionId];
      const exactKey = `${profile.path}\0${extensionId}`;
      if (ext && !seen.has(exactKey)) {
        seen.add(exactKey);
        exactMatches.push(extensionRecord(extensionId, ext, profile, file, options));
      }
      for (const [candidateId, candidate] of Object.entries(settings)) {
        if (candidateId === extensionId) continue;
        const fallbackKey = `${profile.path}\0${candidateId}`;
        if (!seen.has(fallbackKey) && extensionSettingMatches(candidate)) {
          seen.add(fallbackKey);
          fallbackMatches.push({
            ...extensionRecord(candidateId, candidate, profile, file, options),
            matchedBy: 'manifest-or-path',
            configuredExtensionId: extensionId
          });
        }
      }
    }
  }
  return [...exactMatches, ...fallbackMatches];
}

function detectLoadedExtension(options = {}) {
  const extensionId = options.extensionId || process.env.CODEX_CHROME_EXTENSION_ID || 'jfmjfhklogoienhpfnppmbcbjfjnkonk';
  const matches = detectLoadedExtensions(options);
  if (matches.length) return matches[0];
  const profile = findChromeProfile(options.userData || chromeUserDataDir());
  return {
    extensionId,
    profileName: profile.name,
    profilePath: profile.path,
    installed: false,
    loadedPath: null,
    loadedFrom: 'unknown'
  };
}

function httpJson(url, options = {}) {
  const target = new URL(url);
  const method = options.method || 'GET';
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const timeout = options.timeout || 30000;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method,
      timeout,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function joinUrl(baseUrl, route) {
  return new URL(route, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

module.exports = {
  defaultBrowserControlHome,
  defaultDaemonUrl,
  defaultChromeUserDataDir,
  chromeUserDataDir,
  listChromeProfiles,
  findChromeProfile,
  findChrome,
  detectLoadedExtensions,
  detectLoadedExtension,
  httpJson,
  joinUrl,
  printJson
};
