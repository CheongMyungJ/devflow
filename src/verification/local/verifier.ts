import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createConnection } from 'node:net';
import { publish, readJson } from '../../runner/local/files.mjs';
import { loadSchemas } from '../../schema/registry.mjs';
import type { VerificationResult } from '../../types/generated/index.js';
import type { Verifier, VerificationRequest, VerificationState } from '../types.js';
import type { ExecutionSettingsSource } from '../../settings/types.js';

const schemas = loadSchemas();
const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };
async function live(port: number, id: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' }); let text = '';
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500, () => finish(false)); socket.on('error', () => finish(false));
    socket.on('data', bytes => { text += bytes; if (text.length > 100) finish(false); });
    socket.on('end', () => finish(text === id)); socket.on('close', () => resolve(false));
  });
}

/** Durable launch claim + bounded authenticated observation, independent of the invoking CLI lifetime. */
export class LocalVerifier implements Verifier {
  private readonly root: string;
  constructor(root: string, private readonly settings?: ExecutionSettingsSource) { this.root = resolve(root, 'verification'); }
  private dir(id: string) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid verification identity');
    return join(this.root, id);
  }
  async prepare(request: VerificationRequest) {
    const rel = relative(request.workdir, this.root);
    if (!isAbsolute(request.workdir) || rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('Verifier storage must be outside the Task worktree');
    const dir = this.dir(request.id); await mkdir(this.root, { recursive: true });
    if (await exists(dir)) {
      if (!isDeepStrictEqual(await readJson(dir, 'request.json'), request)) throw new Error('Verification preparation is incomplete or differs; inspect existing execution');
      return;
    }
    const project = await this.settings?.project?.(request.workdir);
    if (project?.exclusive || project?.setup?.length) throw new Error('Automatic project setup/exclusive verification is not supported; prepare dependencies and use worktree-local checks');
    const commands = request.commands.map(check => {
      const alias = check.run.startsWith('@') ? project?.commands?.[check.run.slice(1)] : undefined;
      if (check.run.startsWith('@') && !alias) throw new Error(`Unknown deterministic command: ${check.run}`);
      return { ...check, run: alias?.run ?? check.run, timeoutSeconds: alias?.timeout_sec ?? 300 };
    });
    try { await mkdir(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!isDeepStrictEqual(await readJson(dir, 'request.json'), request)) throw new Error('Verification preparation is incomplete or differs; inspect existing execution');
      return;
    }
    await publish(dir, 'plan.json', { ...request, commands });
    await publish(dir, 'request.json', request);
  }
  async submit(id: string): Promise<VerificationState> {
    const state = await this.inspect(id);
    if (state.state !== 'prepared') return state;
    const dir = this.dir(id);
    try { await mkdir(join(dir, 'launch-claim')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.inspect(id);
      throw error;
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./execute.mjs', import.meta.url)), dir], { cwd: dirname(process.execPath), detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    return this.inspect(id);
  }
  async inspect(id: string): Promise<VerificationState> {
    const dir = this.dir(id);
    try {
      if (!await exists(dir)) return { state: 'missing' };
      const request = await readJson(dir, 'request.json') as VerificationRequest | undefined;
      if (!request || request.id !== id) return { state: 'unknown' };
      const result = await readJson(dir, 'result.json') as VerificationResult | undefined;
      if (result) return result.id === id && schemas.validator('verification-result')(result) ? { state: 'completed', result } : { state: 'unknown' };
      if (!await exists(join(dir, 'launch-claim'))) return { state: 'prepared' };
      const owner = await readJson(dir, 'owner.json') as { id: string; port: number } | undefined;
      if (owner?.id === id && await live(owner.port, id)) return { state: 'running' };
      const final = await readJson(dir, 'result.json') as VerificationResult | undefined;
      return final?.id === id && schemas.validator('verification-result')(final) ? { state: 'completed', result: final } : { state: 'unknown' };
    } catch { return { state: 'unknown' }; }
  }
}
