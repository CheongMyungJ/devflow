// Store 의 파일 구현체 (docs/design/store.md 2절). 배치는 devflow-data/README.md 를 따른다.
// 파일 경로, 포맷, lock 에 대한 지식은 이 디렉터리 밖으로 나가지 않는다.

import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type SchemaName, validateAgainst } from '../../schema/validator.js';
import type { Event, Task } from '../../types/generated/index.js';
import {
  CommitOutcomeUnknownError,
  ConflictError,
  InvalidChangeError,
  SchemaViolationError,
  StoreError,
  StoreUnavailableError,
  TaskNotFoundError,
} from '../errors.js';
import type {
  Change,
  ChangeInput,
  CommitResult,
  EntityKeyMap,
  EntityKind,
  EntityMap,
  EntityScopeMap,
  EntityWrite,
  InvalidEntity,
  ListResult,
  NewEvent,
  ReadEventsOptions,
  Store,
} from '../types.js';
import { codeOf, type FileOps, nodeFileOps, retryTransient, sleep } from './fs-ops.js';
import { LockManager } from './lock.js';

export interface FileStoreOptions {
  dataDir: string;
  ops?: FileOps;
  /** lock 을 기다리는 제한 시간. 기본 5초. */
  lockTimeoutMs?: number;
  /** rename/삭제가 일시적 오류(EPERM/EBUSY/EACCES)를 만났을 때 재시도하는 총 시간. 기본 1초. */
  transientRetryMs?: number;
}

interface EntityDef<K extends EntityKind> {
  schema: SchemaName;
  taskIdOf(value: EntityMap[K]): string;
  keyOf(value: EntityMap[K]): EntityKeyMap[K];
  /** Task 디렉터리 기준 상대 위치. */
  relPath(key: EntityKeyMap[K]): string;
  subject(key: EntityKeyMap[K]): string;
}

/** 새 엔티티는 여기에 "kind → 스키마, 위치" 를 추가한다 (store.md 3절). */
const ENTITIES: { [K in EntityKind]: EntityDef<K> } = {
  task: {
    schema: 'task',
    taskIdOf: (task) => task.id,
    keyOf: (task) => ({ taskId: task.id }),
    relPath: () => 'task.yaml',
    subject: (key) => `task ${key.taskId}`,
  },
};

const TASK_DIR = /^T-(\d{4,})$/;
const EVENTS = 'events.jsonl';
const ROLLBACKS = '.rollbacks';
const PENDING_PREFIX = '.pending-';
const LF = 0x0a;

interface PendingFile {
  tmp: string;
  final: string;
}

interface PendingCommit {
  token: string;
  firstSeq: number;
  lines: string[];
  files: PendingFile[];
}

/** 복구 결과. forward-incomplete 는 commit 은 성립했으나 뒷정리(rename)를 마치지 못한 상태다. */
type Recovery =
  | { outcome: 'none' | 'discarded' | 'rolled-back' | 'forward' }
  | { outcome: 'forward-incomplete'; overlay: Map<string, string> };

interface LogLine {
  text: string;
  end: number;
}

function splitLog(buffer: Buffer): { lines: LogLine[]; tornFrom: number | undefined } {
  const lines: LogLine[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== LF) continue;
    lines.push({ text: buffer.toString('utf8', start, i), end: i + 1 });
    start = i + 1;
  }
  return { lines, tornFrom: start < buffer.length ? start : undefined };
}

function seqOf(text: string): number | undefined {
  try {
    const seq = (JSON.parse(text) as { seq?: unknown }).seq;
    return typeof seq === 'number' ? seq : undefined;
  } catch {
    return undefined;
  }
}

export class FileStore implements Store {
  private readonly dataDir: string;
  private readonly ops: FileOps;
  private readonly locks: LockManager;
  private readonly transientRetryMs: number;

  constructor(options: FileStoreOptions) {
    this.dataDir = options.dataDir;
    this.ops = options.ops ?? nodeFileOps;
    this.transientRetryMs = options.transientRetryMs ?? 1000;
    this.locks = new LockManager(this.ops, join(this.dataDir, '.locks'), {
      timeoutMs: options.lockTimeoutMs ?? 5000,
      transientRetryMs: this.transientRetryMs,
    });
  }

  // ---------------------------------------------------------------- 쓰기

  async createTask(build: (taskId: string) => { task: Task; events: [NewEvent, ...NewEvent[]] }): Promise<{ task: Task; events: Event[] }> {
    const taskId = await this.guard(() => this.issueTaskId());
    try {
      const built = build(taskId);
      if (built.task.id !== taskId) throw new InvalidChangeError(`build returned task id ${built.task.id}, issued ${taskId}`);
      const change: Change = { writes: [{ kind: 'task', value: built.task }], events: built.events };
      const result = await this.withLock(taskId, () => this.commitLocked(taskId, change, true));
      return { task: built.task, events: result.events };
    } catch (error) {
      // 기록되지 않았다면 발급된 ID 의 빈 디렉터리를 치운다. ID 는 버려진다(유일하지만 연속은 아니다).
      if (!(error instanceof CommitOutcomeUnknownError)) await this.ops.removeEmptyDir(this.taskDir(taskId)).catch(() => undefined);
      throw error;
    }
  }

  commit(taskId: string, change: ChangeInput): Promise<CommitResult> {
    return this.withLock(taskId, () => this.commitLocked(taskId, change, false));
  }

  /** mkdir 의 원자성으로 유일성을 보장한다. 전역 lock 은 없다 (store.md 2.3). */
  private async issueTaskId(): Promise<string> {
    await this.ops.mkdir(this.dataDir, true);
    let next = 1;
    for (const name of await this.ops.readdir(this.dataDir)) {
      const match = TASK_DIR.exec(name);
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }
    for (;;) {
      const taskId = `T-${String(next).padStart(4, '0')}`;
      try {
        await this.ops.mkdir(this.taskDir(taskId), false);
        return taskId;
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') throw error;
        next++;
      }
    }
  }

  /** store.md 2.4. lock 을 쥔 상태에서 호출한다. */
  private async commitLocked(taskId: string, input: ChangeInput, creating: boolean): Promise<CommitResult> {
    // 1. 이전 commit 의 복구. 끝나지 않으면 디스크를 건드리지 않고 물러난다.
    const recovery = await this.guard(() => this.recover(taskId));
    if (recovery.outcome === 'forward-incomplete') {
      throw new StoreUnavailableError(`previous commit on ${taskId} is committed but its cleanup cannot complete yet`);
    }

    // 2~3. 현재 상태 확인
    const lastSeq = await this.guard(() => this.readLastSeq(taskId));
    if (!creating && lastSeq === 0) throw new TaskNotFoundError(taskId);
    if (creating && lastSeq !== 0) throw new InvalidChangeError(`${taskId} already has events`);
    const change = typeof input === 'function' ? input({ lastSeq }) : input;
    if (!Array.isArray(change.events) || change.events.length === 0) throw new InvalidChangeError('a change must carry at least one event');
    if (change.expectedLastSeq !== undefined && change.expectedLastSeq !== lastSeq) {
      throw new ConflictError(taskId, change.expectedLastSeq, lastSeq);
    }

    // 4. 검증. 여기까지는 디스크를 건드리지 않는다.
    const firstSeq = lastSeq + 1;
    const events = change.events.map((event, i) => ({ ...event, seq: firstSeq + i, task_id: taskId }) as Event);
    events.forEach((event) => this.assertValid('write', 'event', `event ${taskId}#${event.seq}`, event));
    const writes = change.writes ?? [];
    const files = writes.map((write, i) => this.planWrite(taskId, write, i));

    // 5. 무엇을 하려는지 메모한다.
    const token = await this.currentToken(taskId);
    const pendingDir = join(this.taskDir(taskId), `${PENDING_PREFIX}${token}`);
    const lines = events.map((event) => {
      const { seq, task_id, ...rest } = event;
      return JSON.stringify({ seq, task_id, ...rest });
    });
    const pending: PendingCommit = { token, firstSeq, lines, files: files.map(({ tmp, final }) => ({ tmp, final })) };
    try {
      await this.ops.mkdir(pendingDir, true);
      for (const file of files) await this.ops.writeFile(join(pendingDir, file.tmp), file.content);
      await this.ops.writeFile(join(pendingDir, 'commit.json'), JSON.stringify(pending));
    } catch (cause) {
      await this.ops.remove(pendingDir).catch(() => undefined);
      throw new StoreUnavailableError(`cannot prepare commit on ${taskId}`, { cause });
    }

    // 6. commit 시점: events.jsonl 의 firstSeq 이후가 lines 와 정확히 같아지는 때.
    try {
      await this.ops.append(this.eventsFile(taskId), Buffer.from(lines.join('\n') + '\n', 'utf8'));
    } catch (cause) {
      // 어디까지 기록되었는지 모른다. 그 자리에서 복구를 돌려 성립 여부를 판정한다.
      let settled: Recovery;
      try {
        settled = await this.recover(taskId);
      } catch (recoveryError) {
        throw new CommitOutcomeUnknownError(taskId, firstSeq, { cause: recoveryError });
      }
      if (settled.outcome === 'forward' || settled.outcome === 'forward-incomplete') return { events };
      throw new StoreUnavailableError(`cannot append events on ${taskId}`, { cause });
    }

    // 7. 뒷정리. 실패해도 commit 은 성립했다. 남은 .pending 은 다음 접근이 마저 굴린다.
    await this.rollForward(taskId, pendingDir, pending.files).catch(() => false);
    return { events };
  }

  private planWrite(taskId: string, write: EntityWrite, index: number): PendingFile & { content: string } {
    const def = ENTITIES[write.kind];
    const key = def.keyOf(write.value);
    if (def.taskIdOf(write.value) !== taskId) throw new InvalidChangeError(`${def.subject(key)} does not belong to ${taskId}`);
    this.assertValid('write', def.schema, def.subject(key), write.value);
    return { tmp: `${index}.tmp`, final: def.relPath(key), content: stringifyYaml(write.value, { lineWidth: 0 }) };
  }

  // ---------------------------------------------------------------- 복구 (store.md 2.5)

  private async recover(taskId: string): Promise<Recovery> {
    const taskDir = this.taskDir(taskId);
    const pendings = (await this.ops.readdir(taskDir)).filter((name) => name.startsWith(PENDING_PREFIX));
    if (pendings.length === 0) return { outcome: 'none' };
    if (pendings.length > 1) throw this.unexpectedState(taskId, `${pendings.length} pending commits: ${pendings.join(', ')}`);
    const pendingDir = join(taskDir, pendings[0]!);

    let pending: PendingCommit;
    try {
      pending = JSON.parse((await this.ops.readFile(join(pendingDir, 'commit.json'))).toString('utf8')) as PendingCommit;
    } catch (error) {
      // commit.json 이 없거나 온전하지 않다 = 메모를 쓰는 도중 죽었다. 이벤트는 기록되지 않았다.
      // 일시적 읽기 오류를 이렇게 처리하면 성립한 commit 의 쓰기를 잃으므로 구별한다.
      if (codeOf(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      await this.ops.remove(pendingDir);
      return { outcome: 'discarded' };
    }

    // 꼬리: seq = firstSeq-1 인 줄의 끝부터 파일 끝까지. 잘린 마지막 줄을 포함한다.
    const eventsFile = this.eventsFile(taskId);
    const log = await this.readOrEmpty(eventsFile);
    const { lines } = splitLog(log);
    let offset = 0;
    if (pending.firstSeq > 1) {
      const previous = lines.find((line) => seqOf(line.text) === pending.firstSeq - 1);
      if (!previous) throw this.unexpectedState(taskId, `${pendings[0]} expects seq ${pending.firstSeq - 1} to exist`);
      offset = previous.end;
    }
    const tail = log.subarray(offset);
    const expected = Buffer.from(pending.lines.join('\n') + '\n', 'utf8');

    if (tail.equals(expected)) {
      const done = await this.rollForward(taskId, pendingDir, pending.files);
      if (done) return { outcome: 'forward' };
      return { outcome: 'forward-incomplete', overlay: new Map(pending.files.map((f) => [f.final, join(pendingDir, f.tmp)])) };
    }
    if (tail.length < expected.length && expected.subarray(0, tail.length).equals(tail)) {
      // 성립하지 않았다. 자신의 lines 와 일치하는 바이트만 잘라낸다.
      // reader 가 "창 안에서 append 후 되돌리기" 를 알아챌 수 있도록 먼저 카운터를 올린다 (2.7).
      await this.ops.append(join(taskDir, ROLLBACKS), Buffer.from([0x2e]));
      if (offset === 0) await this.ops.remove(eventsFile);
      else await this.ops.truncate(eventsFile, offset);
      await this.ops.remove(pendingDir);
      return { outcome: 'rolled-back' };
    }
    throw this.unexpectedState(taskId, `events after seq ${pending.firstSeq - 1} do not match ${pendings[0]}`);
  }

  /** tmp 를 제자리로 옮기고 메모를 지운다. 몇 번을 해도 결과가 같다. 다 마쳤으면 true. */
  private async rollForward(taskId: string, pendingDir: string, files: PendingFile[]): Promise<boolean> {
    try {
      for (const file of files) {
        const tmp = join(pendingDir, file.tmp);
        if ((await this.ops.size(tmp)) === undefined) continue;
        const final = join(this.taskDir(taskId), file.final);
        await this.ops.mkdir(dirname(final), true);
        await retryTransient(this.transientRetryMs, () => this.ops.rename(tmp, final));
      }
      await retryTransient(this.transientRetryMs, () => this.ops.remove(pendingDir));
      return true;
    } catch {
      return false;
    }
  }

  /** 자동으로 고치지 않는 상태. 아무것도 건드리지 않고 드러낸다. */
  private unexpectedState(taskId: string, message: string): SchemaViolationError {
    return new SchemaViolationError('read', `commit state of ${taskId}`, [
      { path: '', message: `${message}. 자동으로 복구하지 않는다. ${taskId} 의 events.jsonl 과 .pending-* 를 사람이 확인해야 한다` },
    ]);
  }

  // ---------------------------------------------------------------- 읽기 (store.md 2.7)

  async get<K extends EntityKind>(kind: K, key: EntityKeyMap[K]): Promise<EntityMap[K] | undefined> {
    const def = ENTITIES[kind];
    const taskId = key.taskId;
    if (!TASK_DIR.test(taskId)) return undefined;
    const found = await this.readConsistent(taskId, async (overlay) => {
      const rel = def.relPath(key);
      let raw: Buffer;
      try {
        raw = await this.ops.readFile(overlay?.get(rel) ?? join(this.taskDir(taskId), rel));
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
        throw new SchemaViolationError('read', def.subject(key), [{ path: '', message: 'the task has events but this entity is missing' }]);
      }
      let value: unknown;
      try {
        value = parseYaml(raw.toString('utf8'));
      } catch (error) {
        throw new SchemaViolationError('read', def.subject(key), [{ path: '', message: `unparsable: ${(error as Error).message}` }]);
      }
      this.assertValid('read', def.schema, def.subject(key), value);
      return value as EntityMap[K];
    });
    return found.exists ? found.value : undefined;
  }

  async list<K extends EntityKind>(kind: K, scope: EntityScopeMap[K]): Promise<ListResult<EntityMap[K]>> {
    const ids = (await this.guard(() => this.ops.readdir(this.dataDir)))
      .filter((name) => TASK_DIR.test(name))
      .sort((a, b) => Number(TASK_DIR.exec(a)![1]) - Number(TASK_DIR.exec(b)![1]));
    const items: EntityMap[K][] = [];
    const invalid: InvalidEntity[] = [];
    for (const taskId of ids) {
      try {
        const value = await this.get(kind, { taskId } as EntityKeyMap[K]);
        if (value !== undefined && (scope.status === undefined || value.status === scope.status)) items.push(value);
      } catch (error) {
        if (!(error instanceof SchemaViolationError)) throw error;
        invalid.push({ kind, subject: error.subject, issues: error.issues });
      }
    }
    return { items, invalid };
  }

  async readEvents(taskId: string, options?: ReadEventsOptions): Promise<Event[]> {
    const found = TASK_DIR.test(taskId)
      ? await this.readConsistent(taskId, async () => this.parseEvents(taskId, await this.ops.readFile(this.eventsFile(taskId))))
      : { exists: false as const };
    if (!found.exists) throw new TaskNotFoundError(taskId);
    const afterSeq = options?.afterSeq ?? 0;
    return found.value.filter((event) => event.seq > afterSeq);
  }

  private parseEvents(taskId: string, log: Buffer): Event[] {
    const { lines, tornFrom } = splitLog(log);
    const subject = `event log of ${taskId}`;
    if (tornFrom !== undefined) throw new SchemaViolationError('read', subject, [{ path: '', message: 'the last line is not terminated' }]);
    return lines.map((line, i) => {
      let event: unknown;
      try {
        event = JSON.parse(line.text);
      } catch {
        throw new SchemaViolationError('read', subject, [{ path: `/${i}`, message: 'unparsable line' }]);
      }
      this.assertValid('read', 'event', `event ${taskId}#${i + 1}`, event);
      const typed = event as Event;
      if (typed.seq !== i + 1 || typed.task_id !== taskId) {
        throw new SchemaViolationError('read', subject, [
          { path: `/${i}`, message: `expected seq ${i + 1} of ${taskId}, found seq ${typed.seq} of ${typed.task_id}` },
        ]);
      }
      return typed;
    });
  }

  /**
   * lock 없이 읽되 commit 과 겹쳤을 가능성이 있으면 버린다.
   * 표식 S = (events.jsonl 의 크기, .rollbacks 의 크기), P = .pending-* 의 존재. 앞은 S,P 순서로, 뒤는 P,S 순서로 읽는다.
   * 두 크기는 성립한 commit 과 되돌리기에서 각각 반드시 달라지므로 파일 시각에 의존하지 않는다.
   */
  private async readConsistent<T>(
    taskId: string,
    read: (overlay?: Map<string, string>) => Promise<T>,
  ): Promise<{ exists: true; value: T } | { exists: false }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(5 * attempt);
      let outcome: { value: T } | { error: unknown } | undefined;
      let s1: string;
      let s2: string;
      let pending: boolean;
      try {
        s1 = await this.markerS(taskId);
        pending = await this.hasPending(taskId);
        if (!pending && !s1.startsWith('none')) {
          try {
            outcome = { value: await read() };
          } catch (error) {
            outcome = { error };
          }
        }
        pending = (await this.hasPending(taskId)) || pending;
        s2 = await this.markerS(taskId);
      } catch (cause) {
        throw new StoreUnavailableError(`cannot read ${taskId}`, { cause });
      }
      if (pending || s1 !== s2) continue;
      if (s1.startsWith('none')) return { exists: false };
      // 겹치지 않은 읽기다. 이때의 오류는 진짜 오류다.
      if (outcome && 'error' in outcome) throw this.asStoreError(outcome.error, `cannot read ${taskId}`);
      if (outcome) return { exists: true, value: outcome.value };
    }

    // lock 을 잡는다 = 진행 중인 commit 이 끝나기를 기다리고, 죽은 commit 은 복구한 뒤 읽는다.
    return this.withLock(taskId, async () => {
      const recovery = await this.guard(() => this.recover(taskId));
      if ((await this.guard(() => this.markerS(taskId))).startsWith('none')) return { exists: false as const };
      // 뒷정리를 마치지 못했어도 성립한 commit 의 결과가 보여야 한다. tmp 의 내용을 읽는다.
      const overlay = recovery.outcome === 'forward-incomplete' ? recovery.overlay : undefined;
      try {
        return { exists: true as const, value: await read(overlay) };
      } catch (error) {
        throw this.asStoreError(error, `cannot read ${taskId}`);
      }
    });
  }

  private async markerS(taskId: string): Promise<string> {
    const events = await this.ops.size(this.eventsFile(taskId));
    const rollbacks = await this.ops.size(join(this.taskDir(taskId), ROLLBACKS));
    // 크기 0 은 "없음" 과 같다: createTask 가 되돌려진 버려진 ID.
    return `${events ? events : 'none'}:${rollbacks ?? 0}`;
  }

  private async hasPending(taskId: string): Promise<boolean> {
    return (await this.ops.readdir(this.taskDir(taskId))).some((name) => name.startsWith(PENDING_PREFIX));
  }

  // ---------------------------------------------------------------- 공통

  private taskDir(taskId: string): string {
    return join(this.dataDir, taskId);
  }

  private eventsFile(taskId: string): string {
    return join(this.taskDir(taskId), EVENTS);
  }

  private readonly heldTokens = new Map<string, string>();

  private async withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    if (!TASK_DIR.test(taskId)) throw new TaskNotFoundError(taskId);
    const lock = await this.locks.acquire(taskId);
    this.heldTokens.set(taskId, lock.token);
    try {
      return await fn();
    } finally {
      this.heldTokens.delete(taskId);
      await lock.release();
    }
  }

  private async currentToken(taskId: string): Promise<string> {
    const token = this.heldTokens.get(taskId);
    if (!token) throw new Error(`commit on ${taskId} without holding its lock`);
    return token;
  }

  private async readOrEmpty(path: string): Promise<Buffer> {
    try {
      return await this.ops.readFile(path);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return Buffer.alloc(0);
      throw error;
    }
  }

  /** lock 을 쥔 상태에서만 부른다. 복구가 끝난 뒤이므로 잘린 줄이 있으면 손상이다. */
  private async readLastSeq(taskId: string): Promise<number> {
    const { lines, tornFrom } = splitLog(await this.readOrEmpty(this.eventsFile(taskId)));
    const last = lines.at(-1);
    const seq = last ? seqOf(last.text) : 0;
    if (tornFrom !== undefined || seq === undefined) throw this.unexpectedState(taskId, 'events.jsonl ends with an unreadable line');
    return seq;
  }

  private assertValid(phase: 'write' | 'read', schema: SchemaName, subject: string, value: unknown): void {
    const issues = validateAgainst(schema, value);
    if (issues.length > 0) throw new SchemaViolationError(phase, subject, issues);
  }

  private asStoreError(error: unknown, message: string): StoreError {
    return error instanceof StoreError ? error : new StoreUnavailableError(message, { cause: error });
  }

  /** 원시 I/O 오류를 StoreUnavailableError 로 감싼다. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.asStoreError(error, 'store is unavailable');
    }
  }
}
