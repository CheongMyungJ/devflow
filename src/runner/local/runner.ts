import { spawn } from 'node:child_process';
import { mkdir, access, readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { loadSchemas } from '../../schema/registry.mjs';
import type { RunnerLocalOwner, RunnerLocalResult } from '../../types/generated/index.js';
import { ExecutionError, type ExecutionKey, type ExecutionState, type Runner, type RunRequest } from '../types.js';
import { publish, readJson } from './files.mjs';
import type { LocalAdapter } from './adapter.js';

const unknown = (reason: string): ExecutionState => ({ state: 'unknown', reason,
  action: '원래 머신과 runner-dir, supervisor/Worker 및 로컬 관리 파일을 확인하라. 실행 종료가 확인되기 전에는 새 Run을 제출하거나 시작 표식을 제거하지 말 것.' });
const schemas = loadSchemas();
async function exists(path: string) {
  try { await access(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

/** No PID liveness guesses: only a response from the execution's own supervisor proves running. */
async function live(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let text = '';
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(700, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('close', () => resolve(false));
    socket.on('data', (part) => { text += part; if (text.length > 100) finish(false); });
    socket.on('end', () => finish(text === token));
  });
}

export class LocalRunner implements Runner {
  get id() { return this.adapter.id; }
  get version() { return this.adapter.version; }
  get capabilities() { return { supportsResume: this.adapter.capabilities?.supportsResume ?? false,
    supportsLiveMessage: this.adapter.capabilities?.supportsLiveMessage ?? false, supportsStream: true, supportsCancel: true }; }
  private readonly root: string;
  constructor(root: string, private readonly adapter: LocalAdapter) { this.root = resolve(root); }
  private dir(key: ExecutionKey): string {
    if (!/^(T-[0-9]{4,}|I-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(key.taskId) || !/^R-[0-9]{3,}$/.test(key.runId) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(key.executionId)) throw new ExecutionError('invalid execution identity');
    return join(this.root, key.taskId, key.runId, key.executionId);
  }
  private validate(request: RunRequest): void {
    if (!schemas.validator('runner-local-request')(request)) throw new ExecutionError('invalid request or unsupported option (resume/unknown fields)');
    if (!isAbsolute(request.workdir)) throw new ExecutionError('Workspace workdir must be absolute');
    const rel = relative(request.workdir, this.root);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new ExecutionError('runner-dir must be outside the Task worktree');
    if ((request.role === 'worker') !== (request.access === 'write')) throw new ExecutionError('unsupported role/access combination: Worker is write; other roles are read');
    if ((request.backend ?? 'fake') !== this.id) throw new ExecutionError('Runner backend mismatch');
    this.adapter.validate?.(request);
  }
  async prepare(request: RunRequest): Promise<void> {
    this.validate(request);
    const dir = this.dir(request.key);
    await mkdir(resolve(dir, '..'), { recursive: true });
    try { await mkdir(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!isDeepStrictEqual(await readJson(dir, 'request.json'), request) || (await this.inspect(request.key)).state === 'unknown') throw new ExecutionError('execution preparation overlaps, is incomplete, or has different input');
      return;
    }
    await mkdir(join(dir, 'output'));
    const launch = this.adapter.launch(request, dir);
    if (!schemas.validator('runner-local-launch')(launch)) throw new ExecutionError('invalid adapter launch');
    await publish(dir, 'launch.json', launch);
    // Publish request last: an interrupted preparation can never look ready.
    await publish(dir, 'request.json', request);
  }
  async submit(request: RunRequest): Promise<ExecutionState> {
    this.validate(request);
    const dir = this.dir(request.key);
    const saved = await readJson(dir, 'request.json');
    if (!saved) return unknown('local prepared request is missing; no process started by this call');
    if (!isDeepStrictEqual(saved, request)) throw new ExecutionError('existing execution has different input or Workspace location');
    const state = await this.inspect(request.key);
    if (state.state !== 'prepared') return state;
    // Irreversible launch fence. Never remove it, even if spawn reports an error.
    try { await mkdir(join(dir, 'launch-claim')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExecutionError('overlapping submit detected; existing launch preserved');
      throw error;
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), dir], {
      // The supervisor only uses absolute management paths. Do not hold the Task cwd
      // open on Windows after publishing a receipt; only the Worker runs in that cwd.
      cwd: dirname(process.execPath), detached: true, stdio: 'ignore', windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    // A bounded readiness handshake, never a completion wait or a retry of spawn.
    const deadline = Date.now() + 1000;
    do {
      const observed = await this.inspect(request.key);
      if (observed.state !== 'unknown') return observed;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return unknown('supervisor has not acknowledged launch');
  }
  async inspect(key: ExecutionKey): Promise<ExecutionState> {
    const dir = this.dir(key);
    try {
      const request = await readJson(dir, 'request.json') as RunRequest | undefined;
      if (!schemas.validator('runner-local-request')(request) || !isDeepStrictEqual(request!.key, key)) return unknown('local request missing, damaged or identity mismatch');
      if ((request!.backend ?? 'fake') !== this.id) return unknown('local backend mismatch');
      const launch = await readJson(dir, 'launch.json');
      if (!(launch === undefined && this.id === 'fake' && request!.backend === undefined) && !schemas.validator('runner-local-launch')(launch)) return unknown('local launch missing or damaged');
      const result = await this.result(dir, key);
      if (result) return result;
      if (!await exists(join(dir, 'launch-claim'))) {
        if (await exists(join(dir, 'supervisor-claim')) || await exists(join(dir, 'supervisor.json'))) return unknown('launch evidence is inconsistent');
        return { state: 'prepared' };
      }
      const owner = await readJson(dir, 'supervisor.json') as RunnerLocalOwner | undefined;
      if (schemas.validator('runner-local-owner')(owner) && owner!.executionId === key.executionId && await live(owner!.port, key.executionId)) return { state: 'running' };
      // Completion may race with socket closure; reread the immutable receipt.
      return await this.result(dir, key) ?? unknown('launch claimed but supervisor is unavailable; process state cannot be confirmed');
    } catch { return unknown('local execution evidence is unreadable or damaged'); }
  }
  private async result(dir: string, key: ExecutionKey): Promise<ExecutionState | undefined> {
    const result = await readJson(dir, 'result.json') as RunnerLocalResult | undefined;
    if (result === undefined) return undefined;
    if (!schemas.validator('runner-local-result')(result)) return unknown('invalid terminal receipt');
    if (!isDeepStrictEqual(result.key, key)) return unknown('result identity mismatch');
    return result.outcome;
  }
  async cancel(key: ExecutionKey): Promise<ExecutionState> {
    const state = await this.inspect(key);
    if (state.state !== 'running' && state.state !== 'prepared') return state;
    const dir = this.dir(key);
    if (!await readJson(dir, 'cancel.json')) {
      try { await publish(dir, 'cancel.json', { executionId: key.executionId }); }
      catch { if (!await readJson(dir, 'cancel.json')) throw new ExecutionError('cancel request was not recorded'); }
    }
    return this.inspect(key);
  }
  async intakeWorkspace(id: string, create = true): Promise<string> {
    if (!/^I-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new ExecutionError('invalid Intake ID');
    const dir = join(this.root, 'intake-workspaces', id);
    if (create) await mkdir(dir, { recursive: true });
    return dir;
  }
  async message(key: ExecutionKey, input: { id: string; text: string }) {
    if (!this.capabilities.supportsLiveMessage) return { delivered: false, reason: 'Backend does not support live messages; cancel and start a follow-up Run after confirmed exit.' };
    if (!/^[0-9a-f-]{36}$/.test(input.id) || !input.text.trim() || input.text.length > 100000) throw new ExecutionError('invalid message');
    const dir = this.dir(key);
    const request = await readJson(dir, 'request.json') as RunRequest | undefined;
    if (request?.role === 'reviewer') throw new ExecutionError('Reviewer input is immutable');
    const receipt = await readJson(dir, `message-${input.id}.receipt.json`) as { delivered: boolean; reason?: string } | undefined;
    if (receipt) return receipt;
    const state = await this.inspect(key);
    if (state.state !== 'running') return { delivered: false, reason: `execution is ${state.state}` };
    const name = `message-${input.id}.json`;
    const saved = await readJson(dir, name);
    if (saved && !isDeepStrictEqual(saved, input)) throw new ExecutionError('message ID already has different text');
    if (!saved) await publish(dir, name, input);
    return { delivered: false, reason: 'queued; repeat the same message ID to inspect delivery' };
  }
  async logs(key: ExecutionKey, input: { offset?: number; limit?: number } = {}) {
    const offset = input.offset ?? 0, limit = input.limit ?? 32768;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1048576) throw new ExecutionError('invalid log range');
    let bytes: Buffer;
    try { bytes = await readFile(join(this.dir(key), 'transcript.log')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; bytes = Buffer.alloc(0); }
    return { text: bytes.subarray(offset, offset + limit).toString('utf8'), offset, nextOffset: Math.min(bytes.length, offset + limit), truncated: bytes.length > offset + limit };
  }
}
