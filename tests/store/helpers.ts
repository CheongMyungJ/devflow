import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach } from 'vitest';
import { FileStore, type FileOps, type FileStoreOptions, nodeFileOps } from '../../src/store/file/index.js';
import type { NewEvent } from '../../src/store/types.js';
import type { Task } from '../../src/types/generated/index.js';
import { BUILD_DIR, CHILD_SCRIPT } from './paths.js';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 테스트마다 새 임시 디렉터리. 끝나면 지운다. 실제 devflow-data 는 건드리지 않는다. */
export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-store-'));
  created.push(dir);
  return dir;
}

export function newStore(dataDir: string, options: Partial<FileStoreOptions> = {}): FileStore {
  return new FileStore({ dataDir, lockTimeoutMs: 5000, transientRetryMs: 60, ...options });
}

export function sampleTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: 'sample',
    type: 'feature',
    goal: 'g',
    acceptance_criteria: [{ id: 'AC1', text: 't' }],
    target: { repo: 'r', base_branch: 'main', task_branch: `task/${id}` },
    status: 'open',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export const createdEvent: NewEvent = { type: 'task.created', actor: 'system', at: '2026-01-01T00:00:00Z' };
export const noteEvent = (note: string): NewEvent => ({ type: 'task.requirement_added', actor: 'system', at: '2026-01-01T00:00:00Z', data: { note } });

export async function createSample(store: FileStore, overrides: Partial<Task> = {}): Promise<Task> {
  return (await store.createTask((id) => ({ task: sampleTask(id, overrides), events: [createdEvent] }))).task;
}

/** 일부 연산만 바꾼 FileOps. 나머지는 실제 파일 시스템을 쓴다. */
export function opsWith(overrides: Partial<FileOps>): FileOps {
  return { ...nodeFileOps, ...overrides };
}

export function ioError(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code });
}

/** 디렉터리의 모든 파일과 크기. "디스크를 건드리지 않았다" 를 확인하는 데 쓴다. lock 은 제외한다. */
export function snapshot(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.locks') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).replaceAll('\\', '/')] = statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

export const readText = (path: string) => readFileSync(path, 'utf8');

export type CrashPoint = 'during-pending' | 'after-pending' | 'torn-append' | 'partial-append' | 'after-append';

export interface ChildArgs {
  dataDir: string;
  action: 'commit' | 'create' | 'update' | 'issue';
  taskId?: string;
  count?: number;
  label?: string;
  title?: string;
  barrier?: string;
  crashAt?: CrashPoint;
  holdMs?: number;
}

export interface Child {
  process: ChildProcess;
  /** 자식이 stdout 에 해당 줄을 낼 때까지 기다린다. */
  waitFor(line: string): Promise<void>;
  exit: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export function spawnChild(args: ChildArgs): Child {
  const child = spawn(process.execPath, [CHILD_SCRIPT, JSON.stringify({ ...args, build: BUILD_DIR })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const waiters: Array<{ line: string; resolve: () => void }> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const waiter of waiters.splice(0)) {
      if (stdout.split('\n').includes(waiter.line)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('exit', (code) => resolve({ code, stdout, stderr })),
  );
  return {
    process: child,
    exit,
    waitFor: (line) =>
      new Promise<void>((resolve, reject) => {
        if (stdout.split('\n').includes(line)) return resolve();
        waiters.push({ line, resolve });
        void exit.then((result) => reject(new Error(`child exited (${result.code}) before "${line}": ${result.stderr}`)));
      }),
  };
}
