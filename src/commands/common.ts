// Step 한 바퀴의 command 들이 함께 쓰는 것 (docs/design/commands.md 4절, 6절 원칙, 6.3).
// 읽고 판단한 뒤 expectedLastSeq 로 commit 하는 틀, 입력의 모양 검사, 참조 검사, 스키마 검사. 파일 위치를 모른다 — Store 의 인터페이스만 쓴다.

import { isDeepStrictEqual } from 'node:util';
import { loadSchemas, type SchemaRegistry } from '../schema/registry.mjs';
import { CommitOutcomeUnknownError, ConflictError, InvalidChangeError, TaskNotFoundError } from '../store/errors.js';
import { isEventRef, isTaskId, parseArtifactRef, type ParsedArtifactRef } from '../store/refs.js';
import type { Change, CommitContext, CommitResult, NewEvent } from '../store/types.js';
import type { Task } from '../types/generated/index.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { confirmOutcome } from './outcome.js';

const MAX_ATTEMPTS = 5;

/**
 * commands.md 4절의 패턴: 마지막 seq 를 읽고 → prepare 가 읽고 판단해(거부는 여기서 던진다) Change 를 만드는 함수를 돌려주고 →
 * expectedLastSeq 로 commit. ConflictError 면 다시 읽고 다시 판단한다(5번까지). CommitOutcomeUnknownError 는 confirmOutcome(3절).
 * build 는 CommitContext 로 ID·버전을 받는다 — 거기서 던지면(발급될 id 가 기대와 다르다 등) 아무것도 쓰이지 않는다.
 * 모든 이벤트의 ref 는 isEventRef 를 지나야 한다(T-0006 F-003) — 아니면 command 의 버그이므로 InvalidChangeError.
 */
export async function commitAfterReading(
  ctx: CommandContext,
  taskId: string,
  prepare: () => Promise<(c: CommitContext) => Omit<Change, 'expectedLastSeq'>>,
): Promise<CommitResult> {
  if (!isTaskId(taskId)) throw new TaskNotFoundError(taskId);
  for (let attempt = 1; ; attempt++) {
    const lastSeq = (await ctx.store.readEvents(taskId)).at(-1)?.seq ?? 0;
    const build = await prepare();
    let sent: NewEvent[] = [];
    try {
      return await ctx.store.commit(taskId, (c) => {
        const change = build(c);
        const bad = change.events.filter((e) => e.ref !== undefined && !isEventRef(e.ref));
        if (bad.length) throw new InvalidChangeError(`event ref outside the grammar: ${bad.map((e) => e.ref).join(', ')}`);
        sent = change.events;
        return { ...change, expectedLastSeq: lastSeq };
      });
    } catch (error) {
      if (error instanceof ConflictError && attempt < MAX_ATTEMPTS) continue;
      if (error instanceof CommitOutcomeUnknownError) return { events: await confirmOutcome(ctx.store, error, sent), commitId: error.commitId };
      throw error;
    }
  }
}

/** Task 가 있고 open 인가. 없으면 TaskNotFoundError, 끝났으면 거부. */
export async function openTask(ctx: CommandContext, taskId: string): Promise<Task> {
  const task = isTaskId(taskId) ? await ctx.store.get('task', { taskId }) : undefined;
  if (task === undefined) throw new TaskNotFoundError(taskId);
  if (task.status !== 'open') throw new RejectedInputError([`taskId: Task ${taskId} 는 ${task.status} 다 — 끝난 Task 에는 쓰지 않는다`]);
  return task;
}

/** 사람이 한 일을 기록하는 command: ctx.actor 가 human:<id> 여야 한다. 그 id(Feedback 의 author)를 돌려준다. */
export function humanId(ctx: CommandContext): string {
  const m = /^human:(\S.*)$/.exec(ctx.actor);
  if (!m) throw new RejectedInputError([`actor: 사람이 한 일은 human:<id> 로 기록한다 (지금 ${ctx.actor}) — 입구의 --actor`]);
  return m[1]!;
}

/** 입력에 둘 수 없는 이름 — 도구가 채운다(commands.md 6절 원칙, 6.3 공통). */
const TOOL_FILLED = ['id', 'status', 'at', 'seq', 'commitId', 'commit_id', 'systemSha', 'system_sha', 'createdAt', 'created_at', 'submittedAt', 'submitted_at', 'endedAt', 'ended_at', 'version', 'author'];

/** 입력 객체의 키: 받는 것 밖이면 거부(도구가 채우는 필드는 그렇게 말한다). */
export function checkKeys(input: object, allowed: readonly string[], label = 'input'): void {
  const reasons: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || allowed.includes(key)) continue;
    reasons.push(TOOL_FILLED.includes(key) ? `${label}.${key}: 도구가 채우는 필드다 — 입력으로 받지 않는다` : `${label}.${key}: 모르는 입력이다 (받는 것: ${allowed.join(', ')})`);
  }
  if (reasons.length) throw new RejectedInputError(reasons);
}

/** 이벤트의 공통 뒷부분(system_sha, at). 옛 기록과 같은 키 순서가 되게 이벤트의 끝에 붙인다. */
export function tail(ctx: CommandContext, at: string): { system_sha?: string; at: string } {
  return { ...(ctx.systemSha !== undefined ? { system_sha: ctx.systemSha } : {}), at };
}

/** data.note 가 있으면 더한다. */
export const withNote = (data: Record<string, unknown>, note: string | undefined): Record<string, unknown> => (note !== undefined ? { ...data, note } : data);

let registry: SchemaRegistry | undefined;
/** 스키마 위반을 '위치 메시지' 문장으로. 비어 있으면 맞는다. 역할 세션의 출력(worker-output, reviewer-output)처럼 Store 가 검사하지 않는 것에 쓴다. */
export function schemaIssues(name: string, value: unknown, label: string): string[] {
  registry ??= loadSchemas();
  const validate = registry.validator(name);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${label}${e.instancePath || ''}: ${e.message ?? 'invalid'} (schemas/${name}.schema.json)`);
}

/** JSON 문장을 읽는다. 아니면 거부. */
export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RejectedInputError([`${label}: JSON 이 아니다 — ${(error as Error).message}`]);
  }
}

/** commit SHA: 40자(또는 64자) 16진 소문자. */
export const isSha = (s: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);

export const isPositiveInteger = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1;

/** 그 Step 의 그 이름의 가장 새 버전(없으면 0). */
export async function latestVersion(ctx: CommandContext, taskId: string, stepId: string, name: string): Promise<number> {
  const { items } = await ctx.store.list('artifact', { taskId, stepId, name });
  return items.reduce((max, a) => Math.max(max, a.version), 0);
}

/**
 * artifact 참조 검사(commands.md 6.3): 문법(parseArtifactRef — 로컬 경로가 섞이면 맞지 않는다), 이 command 의 Task·Step 과 같은가,
 * 그 버전의 Artifact 가 있는가, (latest 면) 그 이름의 가장 새 버전인가. 까닭은 reasons 에 모은다. 맞으면 나눈 것을 돌려준다.
 */
export async function checkArtifactRef(
  ctx: CommandContext,
  ref: unknown,
  where: { taskId: string; stepId?: string },
  label: string,
  reasons: string[],
  latest = true,
): Promise<ParsedArtifactRef | undefined> {
  const parsed = typeof ref === 'string' ? parseArtifactRef(ref) : undefined;
  if (parsed === undefined) {
    reasons.push(`${label}: ${JSON.stringify(ref)} 는 artifact://<task>/<step>/<name>@v<N> 가 아니다 (로컬 경로는 받지 않는다)`);
    return undefined;
  }
  if (parsed.taskId !== where.taskId || (where.stepId !== undefined && parsed.stepId !== where.stepId)) {
    reasons.push(`${label}: ${ref} 는 ${where.taskId}${where.stepId !== undefined ? `/${where.stepId}` : ''} 의 것이 아니다`);
    return undefined;
  }
  if ((await ctx.store.get('artifact', { ref: ref as string })) === undefined) {
    reasons.push(`${label}: ${ref} 가 없다`);
    return undefined;
  }
  const newest = latest ? await latestVersion(ctx, parsed.taskId, parsed.stepId, parsed.name) : parsed.version;
  if (parsed.version !== newest) {
    reasons.push(`${label}: ${ref} 는 ${parsed.name} 의 가장 새 버전이 아니다 (가장 새 것은 v${newest})`);
    return undefined;
  }
  return parsed;
}

/** 같은 값이 두 번 이상 나온 것. */
export const duplicates = (values: readonly string[]): string[] => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];

/** 두 JSON 값이 같은가(YAML·JSON 을 거쳐 온 값을 비교). */
export const sameJson = (a: unknown, b: unknown): boolean => isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));

/** 거부 까닭이 모였으면 던진다. */
export function rejectIf(reasons: readonly string[]): void {
  if (reasons.length) throw new RejectedInputError(reasons);
}
