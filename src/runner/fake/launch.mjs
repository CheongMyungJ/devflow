import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared by the fake adapter and the ADR-0019 prepared-request compatibility path. */
export function fakeLaunch(dir) {
  return { command: process.execPath,
    args: [fileURLToPath(new URL('./worker.mjs', import.meta.url)), dir],
    stdin: '', env: {}, outputPath: join(dir, 'output.json') };
}
