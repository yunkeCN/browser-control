import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

declare const __BROWSER_CONTROL_PACKAGE_VERSION__: string | undefined;

function scriptDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function loadScriptPackageVersion(): string | null {
  if (typeof __BROWSER_CONTROL_PACKAGE_VERSION__ === 'string' && __BROWSER_CONTROL_PACKAGE_VERSION__) {
    return __BROWSER_CONTROL_PACKAGE_VERSION__;
  }
  const candidates = [
    './package.json',
    '../skills/browser-control/scripts/package.json',
    '../../skills/browser-control/scripts/package.json',
    '../../package.json'
  ];
  for (const candidate of candidates) {
    const resolved = resolve(scriptDir(), candidate);
    try {
      const pkg = JSON.parse(fs.readFileSync(resolved, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw error;
    }
  }
  return null;
}
