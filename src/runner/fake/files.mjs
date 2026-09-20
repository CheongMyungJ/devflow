// Local evidence is machine-only. Publication is atomic for process crashes, not power loss.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(dir, name) {
  try { return JSON.parse(await readFile(join(dir, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export async function publish(dir, name, value) {
  const tmp = join(dir, `${name}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(value), { flag: 'wx' });
  await rename(tmp, join(dir, name));
}
