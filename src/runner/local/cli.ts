import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { CliCommand } from './adapter.js';

/** Resolve npm bins without invoking cmd.exe or interpreting any prompt as shell code. */
export function resolveCli(name: string, npmPackage: string): CliCommand {
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const dir = resolve(entry);
    const native = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(native)) return { command: native };
    if (process.platform !== 'win32') continue;
    const pkg = join(dir, 'node_modules', npmPackage, 'package.json');
    if (!existsSync(pkg)) continue;
    const meta = JSON.parse(readFileSync(pkg, 'utf8')) as { bin: string | Record<string, string> };
    const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin[name];
    if (!bin) continue;
    const path = resolve(dirname(pkg), bin);
    if (existsSync(path)) return path.endsWith('.exe') ? { command: path } : { command: process.execPath, prefixArgs: [path] };
  }
  return { command: name }; // The supervisor records a confirmed spawn failure if absent.
}

export function cliVersion(cli: CliCommand): string {
  const result = spawnSync(cli.command, [...(cli.prefixArgs ?? []), '--version'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 4096,
  });
  // Never persist arbitrary diagnostics, paths or credentials as version metadata.
  return result.status === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? 'unavailable' : 'unavailable';
}
