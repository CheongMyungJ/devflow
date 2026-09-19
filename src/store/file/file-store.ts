// Store 의 파일 구현체 (docs/design/store.md 2절, 나머지 엔티티·blob·ID 발급·commit 식별자는 3절).
// 배치(어느 기록이 어느 파일에 있는가)는 store.md 3.1·3.3 이고 규칙은 layout.ts 한 곳에 있다.
// 파일 경로, 포맷, lock 에 대한 지식은 이 디렉터리 밖으로 나가지 않는다.

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type SchemaName, validateAgainst } from '../../schema/validator.js';
import type { ArtifactVersion, Event, Task } from '../../types/generated/index.js';
import { blobRef, parseBlobRef } from '../blob-ref.js';
import {
  AlreadyExistsError,
  CommitOutcomeUnknownError,
  ConflictError,
  InvalidChangeError,
  SchemaViolationError,
  StoreError,
  StoreUnavailableError,
  TaskNotFoundError,
} from '../errors.js';
import type {
  BlobWrite,
  Change,
  ChangeInput,
  CommitContext,
  CommitResult,
  EntityKeyMap,
  EntityKind,
  EntityMap,
  EntityScopeMap,
  EntityWrite,
  InvalidEntity,
  IssuedIdKind,
  ListResult,
  NewEvent,
  ReadEventsOptions,
  Store,
} from '../types.js';
import { codeOf, type FileOps, nodeFileOps, retryTransient, sleep } from './fs-ops.js';
import {
  artifactRef,
  blobRelPath,
  formatId,
  idNumber,
  isArtifactName,
  isCanonicalId,
  issuedNumberOf,
  type Loc,
  locOfRel,
  parseArtifactRef,
  relOfLoc,
  TASK_DIR,
} from './layout.js';
import { LockManager } from './lock.js';

export interface FileStoreOptions {
  dataDir: string;
  ops?: FileOps;
  /** lock 을 기다리는 제한 시간. 기본 5초. */
  lockTimeoutMs?: number;
  /** rename/삭제가 일시적 오류(EPERM/EBUSY/EACCES)를 만났을 때 재시도하는 총 시간. 기본 1초. */
  transientRetryMs?: number;
}

/** kind → 스키마. 새 엔티티는 여기와 layout.ts 의 Loc 에 더한다 (store.md 3절). */
const SCHEMA: Record<EntityKind, SchemaName> = {
  task: 'task',
  step: 'step',
  decision: 'decision',
  feedback: 'feedback',
  gate_result: 'gate-result',
  run: 'run',
  artifact: 'artifact',
};

/** 이미 있는 key 에 쓰면 AlreadyExistsError 인 kind (store.md 3.2). blob 도 불변이다. */
const IMMUTABLE: ReadonlySet<EntityKind> = new Set(['decision', 'gate_result', 'artifact']);
const ISSUED: IssuedIdKind[] = ['step', 'decision', 'feedback', 'gate_result', 'run'];

type AnyEntity = EntityMap[EntityKind];
type Fields = Record<string, unknown>;

/** 값의 task_id (Task 는 id). */
function taskIdOf(kind: EntityKind, value: AnyEntity): unknown {
  return kind === 'task' ? (value as Task).id : (value as Fields)['task_id'];
}

/** 값이 놓일 자리. 스키마 검증을 통과한 값에만 부른다. Run·Feedback 의 수준은 값의 step_id 로 정해진다. */
function locOfValue(kind: EntityKind, value: AnyEntity): Loc {
  const v = value as Fields;
  const id = v['id'] as string;
  const stepId = v['step_id'] as string | undefined;
  switch (kind) {
    case 'task':
      return { kind };
    case 'step':
      return { kind, stepId: id };
    case 'decision':
      return { kind, id };
    case 'feedback':
    case 'run':
      return { kind, id, ...(stepId !== undefined ? { stepId } : {}) };
    case 'gate_result':
      return { kind, id, stepId: stepId! };
    case 'artifact':
      return { kind, stepId: stepId!, name: v['name'] as string, version: v['version'] as number };
  }
}

/** 오류의 subject: 사람이 읽을 수 있는 식별자. 저장 위치가 아니다. */
function subjectOf(taskId: string, loc: Loc): string {
  switch (loc.kind) {
    case 'task':
      return `task ${taskId}`;
    case 'step':
      return `step ${taskId}/${loc.stepId}`;
    case 'gate_result':
      return `gate_result ${taskId}/${loc.stepId}/${loc.id}`;
    case 'artifact':
      return `artifact ${artifactRef(taskId, loc.stepId, loc.name, loc.version)}`;
    default:
      return `${loc.kind} ${taskId}/${loc.id}`;
  }
}

/** 한 Change 안에서 같은 것을 두 번 쓰는지 가리는 표지. Task 안의 ID 는 kind 마다 유일하므로 Run·Feedback·Gate 는 ID 로 가린다. */
function slotOf(loc: Loc): string {
  switch (loc.kind) {
    case 'task':
      return 'task';
    case 'step':
      return `step ${loc.stepId}`;
    case 'artifact':
      return `artifact ${loc.stepId}/${loc.name}@v${loc.version}`;
    default:
      return `${loc.kind} ${loc.id}`;
  }
}

/** list 의 scope 가운데 자리로 가리는 것. stepId: 생략 = 모두, null = Task 수준만, 문자열 = 그 Step 만 (store.md 3.1). */
function inScope(loc: Loc, scope: { stepId?: string | null; name?: string }): boolean {
  if (scope.stepId !== undefined) {
    const at = 'stepId' in loc ? loc.stepId : undefined;
    if (scope.stepId === null ? at !== undefined : at !== scope.stepId) return false;
  }
  return scope.name === undefined || (loc.kind === 'artifact' && loc.name === scope.name);
}

/** 순서: ID 의 번호 순, Artifact 는 (Step, 이름, 버전) 순 (store.md 3.1). */
function compareLoc(a: Loc, b: Loc): number {
  const num = (loc: Loc): number[] => {
    switch (loc.kind) {
      case 'task':
        return [0];
      case 'step':
        return [idNumber('step', loc.stepId) ?? 0];
      case 'artifact':
        return [idNumber('step', loc.stepId) ?? 0, 0, loc.version];
      default:
        return [idNumber(loc.kind, loc.id) ?? 0, 'stepId' in loc && loc.stepId !== undefined ? (idNumber('step', loc.stepId) ?? 0) : 0];
    }
  };
  const [x, y] = [num(a), num(b)];
  if (a.kind === 'artifact' && b.kind === 'artifact' && x[0] === y[0] && a.name !== b.name) return a.name < b.name ? -1 : 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const EVENTS = 'events.jsonl';
const ROLLBACKS = '.rollbacks';
const PENDING_PREFIX = '.pending-';
const LF = 0x0a;

interface PendingFile {
  tmp: string;
  final: string;
}

type PlannedFile = PendingFile & { content: string | Buffer };

/**
 * 한 commit 의 쓰기를 모으며 확인한다 (store.md 3.1 의 쓰기 때의 확인, 3.2, 3.3).
 * 한 Change 안에서 같은 것을 두 번 쓰면 InvalidChangeError, 디스크(lock 을 쥔 뒤의 목록)와 부딪치면 AlreadyExistsError.
 */
class WritePlan {
  private readonly present: Set<string>;
  /** "kind id" → 그 ID 의 기록이 있는 자리들 (Task 안의 ID 유일성). */
  private readonly records = new Map<string, string[]>();
  private readonly slots = new Set<string>();
  private readonly keys = new Set<string>();

  constructor(
    readonly taskId: string,
    existing: string[],
  ) {
    this.present = new Set(existing);
    for (const rel of existing) {
      const loc = locOfRel(taskId, rel);
      if (!loc || loc.kind === 'blob' || !('id' in loc)) continue;
      const key = `${loc.kind} ${loc.id}`;
      this.records.set(key, [...(this.records.get(key) ?? []), rel]);
    }
  }

  has(rel: string): boolean {
    return this.present.has(rel);
  }

  entity(kind: EntityKind, loc: Loc, subject: string, tmp: string, content: string): PlannedFile {
    const slot = slotOf(loc);
    if (this.slots.has(slot)) throw new InvalidChangeError(`${subject}: written twice in one change`);
    this.slots.add(slot);
    const rel = relOfLoc(loc);
    // 불변 kind 는 같은 자리에 다시 쓸 수 없다. 내용이 같아도 거부한다.
    if (IMMUTABLE.has(kind) && this.present.has(rel)) throw new AlreadyExistsError(subject);
    // Task 안의 ID 는 kind 마다 유일하다: 다른 수준이나 다른 Step 에 같은 ID 가 있으면 가변 kind 라도 거부한다.
    if ('id' in loc && (this.records.get(`${loc.kind} ${loc.id}`) ?? []).some((other) => other !== rel)) {
      throw new AlreadyExistsError(`${subject} (${loc.id} is already used at another place in ${this.taskId})`);
    }
    return { tmp, final: rel, content };
  }

  /** blob 의 key. 소유자가 다른 Task 이거나 문법에 맞지 않거나 한 Change 에 두 번이면 InvalidChangeError. */
  blobKey(blob: BlobWrite): string {
    if (blob.owner.taskId !== this.taskId) throw new InvalidChangeError(`a blob owned by ${blob.owner.taskId} cannot be written to ${this.taskId}`);
    const key = blobRef(blob.owner, blob.name);
    if (this.keys.has(key)) throw new InvalidChangeError(`blob ${key}: written twice in one change`);
    this.keys.add(key);
    return key;
  }

  blob(blob: BlobWrite, key: string, tmp: string): PlannedFile {
    const rel = blobRelPath(parseBlobRef(key)!);
    if (this.present.has(rel)) throw new AlreadyExistsError(`blob ${key}`);
    return { tmp, final: rel, content: typeof blob.content === 'string' ? blob.content : Buffer.from(blob.content) };
  }
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
    // commit 식별자는 호출마다 하나 (store.md 3.5). lock 을 잡기 전에 만들어 두므로 이 호출 안에서는 무엇을 다시 해도 같은 값이다.
    const commitId = randomUUID();
    const taskId = await this.guard(() => this.issueTaskId());
    try {
      const built = build(taskId);
      if (built.task.id !== taskId) throw new InvalidChangeError(`build returned task id ${built.task.id}, issued ${taskId}`);
      const change: Change = { writes: [{ kind: 'task', value: built.task }], events: built.events };
      const result = await this.withLock(taskId, (token) => this.commitLocked(taskId, token, change, true, commitId));
      return { task: built.task, events: result.events };
    } catch (error) {
      // 기록되지 않았다면 발급된 ID 의 빈 디렉터리를 치운다. ID 는 버려진다(유일하지만 연속은 아니다).
      if (!(error instanceof CommitOutcomeUnknownError)) await this.ops.removeEmptyDir(this.taskDir(taskId)).catch(() => undefined);
      throw error;
    }
  }

  commit(taskId: string, change: ChangeInput): Promise<CommitResult> {
    const commitId = randomUUID(); // 호출마다 하나 (store.md 3.5)
    return this.withLock(taskId, (token) => this.commitLocked(taskId, token, change, false, commitId));
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
  private async commitLocked(taskId: string, token: string, input: ChangeInput, creating: boolean, commitId: string): Promise<CommitResult> {
    // 1. 이전 commit 의 복구. 끝나지 않으면 디스크를 건드리지 않고 물러난다.
    const recovery = await this.guard(() => this.recover(taskId));
    if (recovery.outcome === 'forward-incomplete') {
      throw new StoreUnavailableError(`previous commit on ${taskId} is committed but its cleanup cannot complete yet`);
    }

    // 2~3. 현재 상태 확인. 기록의 목록은 lock 을 쥔 뒤, 복구가 끝난 디스크에서 읽는다 — ID 발급(3.4)과 덮어쓰기 방지(3.2)의 기준이다.
    const lastSeq = await this.guard(() => this.readLastSeq(taskId));
    if (!creating && lastSeq === 0) throw new TaskNotFoundError(taskId);
    if (creating && lastSeq !== 0) throw new InvalidChangeError(`${taskId} already has events`);
    const existing = creating ? [] : await this.guard(() => this.scan(taskId));
    const change = typeof input === 'function' ? input(this.commitContext(taskId, lastSeq, existing)) : input;
    if (!Array.isArray(change.events) || change.events.length === 0) throw new InvalidChangeError('a change must carry at least one event');
    if (change.expectedLastSeq !== undefined && change.expectedLastSeq !== lastSeq) {
      throw new ConflictError(taskId, change.expectedLastSeq, lastSeq);
    }

    // 4. 검증과 덮어쓰기 방지. 여기까지는 디스크를 건드리지 않는다.
    const firstSeq = lastSeq + 1;
    const events = change.events.map((event, i) => {
      // commit_id 는 Store 가 부여한다(3.5). 타입(NewEvent)을 우회해 보낸 값은 호출자의 버그다.
      if (typeof event === 'object' && event !== null && 'commit_id' in event) {
        throw new InvalidChangeError(`event ${i + 1} of the change carries commit_id; the store assigns it`);
      }
      const { seq: _seq, task_id: _taskId, ...rest } = event as NewEvent & { seq?: unknown; task_id?: unknown };
      // 이벤트 줄의 필드 순서는 seq, task_id, commit_id, 나머지.
      return { seq: firstSeq + i, task_id: taskId, commit_id: commitId, ...rest } as Event;
    });
    events.forEach((event) => this.assertValid('write', 'event', `event ${taskId}#${event.seq}`, event));
    const plan = new WritePlan(taskId, existing);
    const blobKeys = (change.blobs ?? []).map((blob) => plan.blobKey(blob));
    const files = [
      ...(change.writes ?? []).map((write, i) => this.planWrite(plan, write, `${i}.tmp`, blobKeys)),
      ...(change.blobs ?? []).map((blob, i) => plan.blob(blob, blobKeys[i]!, `b${i}.tmp`)),
    ];

    // 5. 무엇을 하려는지 메모한다.
    const pendingDir = join(this.taskDir(taskId), `${PENDING_PREFIX}${token}`);
    const lines = events.map((event) => JSON.stringify(event));
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
        throw new CommitOutcomeUnknownError(taskId, firstSeq, commitId, { cause: recoveryError });
      }
      if (settled.outcome === 'forward' || settled.outcome === 'forward-incomplete') return { events, commitId };
      throw new StoreUnavailableError(`cannot append events on ${taskId}`, { cause });
    }

    // 7. 뒷정리. 실패해도 commit 은 성립했다. 남은 .pending 은 다음 접근이 마저 굴린다.
    await this.rollForward(taskId, pendingDir, pending.files).catch(() => false);
    return { events, commitId };
  }

  /** 엔티티 쓰기 하나를 검사하고 자리를 정한다 (store.md 3.1 의 쓰기 때의 확인, 3.2 의 덮어쓰기 방지). */
  private planWrite(plan: WritePlan, write: EntityWrite, tmp: string, blobKeys: string[]): PlannedFile {
    const { kind, value } = write;
    const taskId = plan.taskId;
    const loose = `${kind} ${String(taskIdOf(kind, value))}/${String((value as Fields)['id'] ?? (value as Fields)['ref'] ?? '?')}`;
    if (taskIdOf(kind, value) !== taskId) throw new InvalidChangeError(`${kind === 'task' ? `task ${String((value as Task).id)}` : loose} does not belong to ${taskId}`);
    this.assertValid('write', SCHEMA[kind], kind === 'task' ? `task ${taskId}` : loose, value);
    const loc = locOfValue(kind, value);
    const subject = subjectOf(taskId, loc);

    // ID 는 파일 이름이 되므로 쓰기 전에 모양을 확인한다.
    const stepId = 'stepId' in loc ? loc.stepId : undefined;
    if (stepId !== undefined && !isCanonicalId('step', stepId)) throw new InvalidChangeError(`${subject}: step id ${stepId} is not of the form step-NNN`);
    if ('id' in loc && !isCanonicalId(loc.kind, loc.id)) throw new InvalidChangeError(`${subject}: id ${loc.id} is not of the form ${formatId(loc.kind, 1).replace('001', 'NNN')}`);
    if (loc.kind === 'artifact') {
      if (!isArtifactName(loc.name)) throw new InvalidChangeError(`${subject}: name ${loc.name} cannot be used as an artifact name`);
      const ref = (value as ArtifactVersion).ref;
      if (ref !== artifactRef(taskId, loc.stepId, loc.name, loc.version)) {
        throw new InvalidChangeError(`${subject}: ref ${ref} does not match task_id, step_id, name and version`);
      }
      this.checkArtifactContent(plan, value as ArtifactVersion, subject, blobKeys);
    }
    return plan.entity(kind, loc, subject, tmp, stringifyYaml(value, { lineWidth: 0 }));
  }

  /**
   * Artifact 의 content_key·work_notes_key 는 같은 Task·같은 Step 의 blob 이고, 이 commit 에서 함께 쓰이거나 이미 있어야 한다.
   * 스키마는 key 의 문법만 본다(store.md 3.6). 여기서 막지 않으면 없는 blob 을 가리키는 불변 기록이 남는다(3.3).
   */
  private checkArtifactContent(plan: WritePlan, value: ArtifactVersion, subject: string, blobKeys: string[]): void {
    for (const field of ['content_key', 'work_notes_key'] as const) {
      const key = value[field];
      if (key === undefined) continue;
      const parsed = parseBlobRef(key);
      if (!parsed || parsed.taskId !== value.task_id || parsed.stepId !== value.step_id) {
        throw new InvalidChangeError(`${subject}: ${field} ${key} is not a blob of ${value.task_id}/${value.step_id}`);
      }
      if (!blobKeys.includes(key) && !plan.has(blobRelPath(parsed))) {
        throw new InvalidChangeError(`${subject}: ${field} ${key} does not exist and is not written in this change`);
      }
    }
  }

  /** CommitContext (store.md 3.4). lock 을 쥔 뒤의 기록 목록으로 센다. 같은 컨텍스트에서 다시 부르면 다음 번호. */
  private commitContext(taskId: string, lastSeq: number, existing: string[]): CommitContext {
    const max = new Map<IssuedIdKind, number>();
    for (const kind of ISSUED) {
      let n = 0;
      for (const rel of existing) n = Math.max(n, issuedNumberOf(taskId, rel, kind) ?? 0);
      max.set(kind, n);
    }
    const versions = new Map<string, number>();
    for (const rel of existing) {
      const loc = locOfRel(taskId, rel);
      if (loc?.kind !== 'artifact') continue;
      const key = `${loc.stepId}/${loc.name}`;
      versions.set(key, Math.max(versions.get(key) ?? 0, loc.version));
    }
    return {
      lastSeq,
      nextId(kind) {
        if (!max.has(kind)) throw new InvalidChangeError(`no ids are issued for ${String(kind)}`);
        const n = max.get(kind)! + 1;
        max.set(kind, n);
        return formatId(kind, n);
      },
      nextArtifactVersion(stepId, name) {
        const key = `${stepId}/${name}`;
        const n = (versions.get(key) ?? 0) + 1;
        versions.set(key, n);
        return n;
      },
    };
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
    const target = this.locOfKey(kind, key);
    if (!target) return undefined; // 모양이 맞지 않는 key 가 가리키는 기록은 없다(디스크를 보지 않는다)
    const { taskId, loc } = target;
    const found = await this.readConsistent(taskId, async (overlay) => {
      if (loc.kind === 'task') {
        try {
          return await this.readEntity(taskId, loc, overlay);
        } catch (error) {
          if (codeOf(error) !== 'ENOENT') throw error;
          throw new SchemaViolationError('read', subjectOf(taskId, loc), [{ path: '', message: 'the task has events but this entity is missing' }]);
        }
      }
      // Run·Feedback 은 key 에 수준이 없다: 두 수준(Task 와 모든 Step)을 찾아 본다 (store.md 3.1).
      const places =
        loc.kind === 'run' || loc.kind === 'feedback'
          ? (await this.scan(taskId, overlay)).map((rel) => locOfRel(taskId, rel)).filter((at): at is Loc => at?.kind === loc.kind && at.id === loc.id)
          : [loc];
      if (places.length > 1) {
        const levels = places.map((at) => ('stepId' in at && at.stepId !== undefined ? at.stepId : 'task level')).join(', ');
        throw new SchemaViolationError('read', subjectOf(taskId, loc), [{ path: '', message: `the same id is stored at more than one place: ${levels}` }]);
      }
      if (places.length === 0) return undefined;
      try {
        return await this.readEntity(taskId, places[0]!, overlay);
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return undefined;
        throw error;
      }
    });
    return found.exists ? (found.value as EntityMap[K] | undefined) : undefined;
  }

  async list<K extends EntityKind>(kind: K, scope: EntityScopeMap[K]): Promise<ListResult<EntityMap[K]>> {
    if (kind === 'task') return this.listTasks(scope as EntityScopeMap['task']) as Promise<ListResult<EntityMap[K]>>;
    const s = scope as { taskId: string; stepId?: string | null; name?: string; status?: string; kind?: string; role?: string };
    const empty: ListResult<EntityMap[K]> = { items: [], invalid: [] };
    if (typeof s.taskId !== 'string' || !TASK_DIR.test(s.taskId)) return empty;
    const taskId = s.taskId;
    const found = await this.readConsistent(taskId, async (overlay) => {
      // 이름이 그 kind 의 모양인 파일만 읽는다. 같은 디렉터리의 blob(R-002.work-notes.md 등)은 items 에도 invalid 에도 들지 않는다.
      const places = (await this.scan(taskId, overlay))
        .map((rel) => locOfRel(taskId, rel))
        .filter((at): at is Loc => at?.kind === kind && inScope(at, s))
        .sort(compareLoc);
      const result: ListResult<EntityMap[K]> = { items: [], invalid: [] };
      for (const at of places) {
        try {
          const value = (await this.readEntity(taskId, at, overlay)) as Fields;
          if (s.status !== undefined && value['status'] !== s.status) continue;
          if (s.kind !== undefined && value['kind'] !== s.kind) continue;
          if (s.role !== undefined && value['role'] !== s.role) continue;
          result.items.push(value as EntityMap[K]);
        } catch (error) {
          if (!(error instanceof SchemaViolationError)) throw error;
          result.invalid.push({ kind, subject: error.subject, issues: error.issues });
        }
      }
      return result;
    });
    return found.exists ? found.value : empty;
  }

  private async listTasks(scope: EntityScopeMap['task']): Promise<ListResult<Task>> {
    const ids = (await this.guard(() => this.ops.readdir(this.dataDir)))
      .filter((name) => TASK_DIR.test(name))
      .sort((a, b) => Number(TASK_DIR.exec(a)![1]) - Number(TASK_DIR.exec(b)![1]));
    const items: Task[] = [];
    const invalid: InvalidEntity[] = [];
    for (const taskId of ids) {
      try {
        const value = await this.get('task', { taskId });
        if (value !== undefined && (scope.status === undefined || value.status === scope.status)) items.push(value);
      } catch (error) {
        if (!(error instanceof SchemaViolationError)) throw error;
        invalid.push({ kind: 'task', subject: error.subject, issues: error.issues });
      }
    }
    return { items, invalid };
  }

  async getBlob(ref: string): Promise<Uint8Array | undefined> {
    const parsed = parseBlobRef(ref);
    if (!parsed) return undefined; // 문법에 맞지 않는 key 의 blob 은 없다
    const rel = blobRelPath(parsed);
    const found = await this.readConsistent(parsed.taskId, async (overlay) => {
      try {
        return await this.readRel(parsed.taskId, rel, overlay);
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return undefined;
        throw error;
      }
    });
    return found.exists ? found.value : undefined;
  }

  /** key 가 가리키는 Task 와 자리. key 의 모양이 맞지 않으면 undefined. Run·Feedback 의 수준은 모르므로 stepId 없이 둔다. */
  private locOfKey<K extends EntityKind>(kind: K, key: EntityKeyMap[K]): { taskId: string; loc: Loc } | undefined {
    const k = key as { taskId?: unknown; stepId?: unknown; id?: unknown; ref?: unknown };
    if (kind === 'artifact') {
      const parsed = typeof k.ref === 'string' ? parseArtifactRef(k.ref) : undefined;
      return parsed && { taskId: parsed.taskId, loc: { kind: 'artifact', stepId: parsed.stepId, name: parsed.name, version: parsed.version } };
    }
    if (typeof k.taskId !== 'string' || !TASK_DIR.test(k.taskId)) return undefined;
    const taskId = k.taskId;
    const stepOk = typeof k.stepId === 'string' && idNumber('step', k.stepId) !== undefined;
    const idOk = (issued: IssuedIdKind) => typeof k.id === 'string' && idNumber(issued, k.id) !== undefined;
    switch (kind) {
      case 'task':
        return { taskId, loc: { kind: 'task' } };
      case 'step':
        return stepOk ? { taskId, loc: { kind: 'step', stepId: k.stepId as string } } : undefined;
      case 'decision':
      case 'feedback':
      case 'run':
        return idOk(kind) ? { taskId, loc: { kind, id: k.id as string } } : undefined;
      case 'gate_result':
        return stepOk && idOk('gate_result') ? { taskId, loc: { kind: 'gate_result', id: k.id as string, stepId: k.stepId as string } } : undefined;
      default:
        return undefined;
    }
  }

  /**
   * 자리의 기록을 읽어 스키마로 검증하고, 값이 그 자리의 것인지(ID, task_id, 수준, Artifact 의 ref) 확인한다.
   * 파일이 없으면 ENOENT 를 그대로 던진다. 그 밖의 문제는 SchemaViolationError(read).
   */
  private async readEntity(taskId: string, loc: Loc, overlay: Map<string, string> | undefined): Promise<AnyEntity> {
    const kind = loc.kind;
    const subject = subjectOf(taskId, loc);
    const rel = relOfLoc(loc);
    const raw = await this.readRel(taskId, rel, overlay);
    let value: unknown;
    try {
      value = parseYaml(raw.toString('utf8'));
    } catch (error) {
      throw new SchemaViolationError('read', subject, [{ path: '', message: `unparsable: ${(error as Error).message}` }]);
    }
    this.assertValid('read', SCHEMA[kind], subject, value);
    const entity = value as AnyEntity;
    const misplaced =
      taskIdOf(kind, entity) !== taskId ||
      relOfLoc(locOfValue(kind, entity)) !== rel ||
      (kind === 'artifact' && (entity as ArtifactVersion).ref !== artifactRef(taskId, (entity as ArtifactVersion).step_id, (entity as ArtifactVersion).name, (entity as ArtifactVersion).version));
    if (misplaced) {
      throw new SchemaViolationError('read', subject, [{ path: '', message: 'the stored value does not belong to this place (id, task_id, step_id or ref differs)' }]);
    }
    return entity;
  }

  /** Task 디렉터리 기준 위치의 파일을 읽는다. 뒷정리가 남은 commit 의 결과는 .pending 의 tmp 에서 읽는다(2.4). */
  private async readRel(taskId: string, rel: string, overlay: Map<string, string> | undefined): Promise<Buffer> {
    const tmp = overlay?.get(rel);
    if (tmp !== undefined) {
      try {
        return await this.ops.readFile(tmp);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error; // 이미 제자리로 옮겨졌다
      }
    }
    return this.ops.readFile(join(this.taskDir(taskId), rel));
  }

  /**
   * Task 디렉터리 안에서 Store 가 다루는 디렉터리의 파일 목록(Task 디렉터리 기준 위치). 무엇이 어느 kind 인지는 layout.ts 의 locOfRel 이 정한다.
   * overlay 가 있으면(뒷정리가 남은 commit) 그 파일들도 있는 것으로 센다.
   */
  private async scan(taskId: string, overlay?: Map<string, string>): Promise<string[]> {
    const dir = this.taskDir(taskId);
    const found = new Set<string>(overlay ? overlay.keys() : []);
    const addAll = async (rel: string) => {
      for (const name of await this.entries(join(dir, rel))) found.add(`${rel}/${name}`);
    };
    for (const sub of ['decisions', 'feedback', 'runs']) await addAll(sub);
    for (const step of await this.entries(join(dir, 'steps'))) {
      const stepRel = `steps/${step}`;
      if ((await this.entries(join(dir, stepRel))).includes('step.yaml')) found.add(`${stepRel}/step.yaml`);
      for (const sub of ['feedback', 'runs', 'gates']) await addAll(`${stepRel}/${sub}`);
      for (const name of await this.entries(join(dir, stepRel, 'artifacts'))) await addAll(`${stepRel}/artifacts/${name}`);
    }
    return [...found];
  }

  /** 디렉터리의 항목. 없거나 디렉터리가 아니면 빈 배열. */
  private async entries(path: string): Promise<string[]> {
    try {
      return await this.ops.readdir(path);
    } catch (error) {
      if (codeOf(error) === 'ENOTDIR') return [];
      throw error;
    }
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

  private async withLock<T>(taskId: string, fn: (token: string) => Promise<T>): Promise<T> {
    if (!TASK_DIR.test(taskId)) throw new TaskNotFoundError(taskId);
    const lock = await this.locks.acquire(taskId);
    try {
      return await fn(lock.token);
    } finally {
      await lock.release();
    }
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
    // seq 는 1부터 빈틈없으므로 줄 수와 같아야 한다. 중간이 손상된 로그 위에 commit 을 더 쌓지 않는다.
    if (seq !== lines.length) throw this.unexpectedState(taskId, `events.jsonl has ${lines.length} lines but its last seq is ${seq}`);
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
