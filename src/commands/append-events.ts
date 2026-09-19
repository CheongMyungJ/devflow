// appendEvents: 다른 command 가 쓰지 않는 이벤트를 넣는 입구의 command (docs/design/commands.md 6.2, 6.3).

import { CommitOutcomeUnknownError, ConflictError, TaskNotFoundError } from '../store/errors.js';
import type { NewEvent } from '../store/types.js';
import type { Event } from '../types/generated/index.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { confirmOutcome } from './outcome.js';
import { recordedAt } from './time.js';

/**
 * 이 command 가 받는 이벤트 타입. 짝이 되는 엔티티가 없어 다른 command 가 쓰지 않는 것만이다(commands.md 6.3).
 * event 스키마의 나머지 타입은 짝이 되는 엔티티나 status 와 함께 한 commit 으로 쓰는 command 가 있다(또는 생길 것이다) —
 * 여기로 넣으면 "step.yaml 의 status = 마지막 step.status_changed 의 to" 같은 등식이 깨진다.
 */
export const APPENDABLE_EVENT_TYPES = ['ledger.updated', 'run.message_sent', 'decision.answered', 'task.requirement_added'] as const;
export type AppendableEventType = (typeof APPENDABLE_EVENT_TYPES)[number];

/** Task 가 open 이 아니어도(done·aborted 뒤에도) 받는 타입. 끝난 Task 의 Ledger 를 고친 사실은 남길 수 있다. */
const AFTER_CLOSE: readonly string[] = ['ledger.updated'];

/** 도구가 채우는 필드 — 입력에 있으면 거부한다. */
const TOOL_FILLED = ['at', 'seq', 'task_id', 'commit_id', 'system_sha', 'actor'] as const;
const INPUT_FIELDS = ['type', 'step_id', 'run_id', 'ref', 'data'] as const;

/** event 스키마의 타입 가운데 이 command 가 받지 않는 것 — 거부 문구를 알맞게 하려는 것뿐이다. 판정은 APPENDABLE_EVENT_TYPES 로 한다. */
const WRITTEN_BY_COMMANDS: Readonly<Record<string, string>> = {
  'task.created': 'createTask',
  'task.done': 'completeTask',
  'task.aborted': 'Task 의 status 와 함께 쓰는 command',
  'decision.made': 'recordDecision',
  'step.proposed': 'recordDecision',
  'step.defined': 'defineStep',
  'step.status_changed': 'status 를 바꾸는 command',
  'step.cancelled': 'Step 의 status 와 함께 쓰는 command',
  'run.submitted': 'submitRun',
  'run.completed': 'completeRun·recordGate·recordDecision',
  'run.failed': 'failRun',
  'run.cancelled': 'Run 의 status 와 함께 쓰는 command',
  'artifact.version_added': 'completeRun',
  'artifact.approved': 'approveStep',
  'feedback.added': 'addFeedback·requestRevision·approveStep',
  'gate.completed': 'recordGate',
};

/** 입력의 이벤트 하나. 나머지(actor, at, system_sha, seq, task_id, commit_id)는 도구가 채운다. */
export interface AppendEventInput {
  type: AppendableEventType;
  step_id?: string;
  run_id?: string;
  ref?: string;
  data?: Record<string, unknown>;
}

export interface AppendEventsInput {
  taskId: string;
  /** 모두 한 commit 에 들어간다. 하나 이상. */
  events: readonly AppendEventInput[];
}

const MAX_ATTEMPTS = 5;

/**
 * 이벤트를 한 commit 으로 기록한다. 도구가 채우는 것: actor(ctx.actor), at(초 단위 UTC — 모든 이벤트가 같은 값), system_sha(ctx.systemSha),
 * seq·task_id·commit_id(Store). ledger.md 는 쓰지 않는다.
 *
 * 아무것도 쓰기 전에 거부한다(RejectedInputError): 입력이 배열이 아니거나 비었다, 도구가 채우는 필드가 있다, 모르는 필드가 있다,
 * type 이 APPENDABLE_EVENT_TYPES 밖이다, step_id·run_id 가 그 Task 에 없다, Task 가 open 이 아닌데 ledger.updated 가 아닌 것이 있다.
 * 없는 Task 는 Store 의 TaskNotFoundError, 스키마 위반은 SchemaViolationError(write) 가 그대로 올라온다.
 * 읽은 뒤 다른 commit 이 끼어들면(ConflictError) 다시 읽고 다시 판단한다(commands.md 4절).
 *
 * @returns 기록된 이벤트(seq·commit_id 포함)
 */
export async function appendEvents(ctx: CommandContext, input: AppendEventsInput): Promise<Event[]> {
  const { taskId } = input;
  const given = checkShape(input.events);
  const at = recordedAt(ctx.clock);
  const events = given.map(
    (e): NewEvent => ({
      type: e.type,
      actor: ctx.actor,
      ...(e.step_id !== undefined ? { step_id: e.step_id } : {}),
      ...(e.run_id !== undefined ? { run_id: e.run_id } : {}),
      ...(e.ref !== undefined ? { ref: e.ref } : {}),
      ...(e.data !== undefined ? { data: e.data } : {}),
      ...(ctx.systemSha !== undefined ? { system_sha: ctx.systemSha } : {}),
      at,
    }),
  ) as [NewEvent, ...NewEvent[]];

  for (let attempt = 1; ; attempt++) {
    const lastSeq = (await ctx.store.readEvents(taskId)).at(-1)?.seq ?? 0;
    await checkState(ctx, taskId, given);
    try {
      return (await ctx.store.commit(taskId, { expectedLastSeq: lastSeq, events })).events;
    } catch (error) {
      if (error instanceof ConflictError && attempt < MAX_ATTEMPTS) continue;
      if (error instanceof CommitOutcomeUnknownError) return confirmOutcome(ctx.store, error, events);
      throw error;
    }
  }
}

/** 입력의 모양. Store 를 부르지 않는다. */
function checkShape(events: unknown): AppendEventInput[] {
  if (!Array.isArray(events) || events.length === 0) throw new RejectedInputError(['events: 이벤트가 하나 이상인 배열이어야 한다']);
  const reasons: string[] = [];
  events.forEach((event: unknown, i) => {
    const at = `events[${i}]`;
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      reasons.push(`${at}: 객체가 아니다`);
      return;
    }
    const e = event as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if ((TOOL_FILLED as readonly string[]).includes(key)) reasons.push(`${at}.${key}: 도구가 채우는 필드다 — 입력에 두지 않는다`);
      else if (!(INPUT_FIELDS as readonly string[]).includes(key)) reasons.push(`${at}.${key}: 모르는 필드다 (받는 것: ${INPUT_FIELDS.join(', ')})`);
    }
    const type = e['type'];
    if (typeof type !== 'string') reasons.push(`${at}.type: 문자열이어야 한다`);
    else if (!(APPENDABLE_EVENT_TYPES as readonly string[]).includes(type)) {
      const by = WRITTEN_BY_COMMANDS[type];
      reasons.push(
        by !== undefined
          ? `${at}.type: ${type} 는 ${by} 가 짝이 되는 기록과 함께 쓰는 이벤트다 — append-events 로 넣지 않는다`
          : `${at}.type: ${type} 는 받지 않는 타입이다 (받는 것: ${APPENDABLE_EVENT_TYPES.join(', ')})`,
      );
    }
    for (const key of ['step_id', 'run_id', 'ref'] as const) {
      if (e[key] !== undefined && (typeof e[key] !== 'string' || e[key] === '')) reasons.push(`${at}.${key}: 비어 있지 않은 문자열이어야 한다`);
    }
    const data = e['data'];
    if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) reasons.push(`${at}.data: 객체여야 한다`);
  });
  if (reasons.length) throw new RejectedInputError(reasons);
  return events as AppendEventInput[];
}

/** 지금 상태에서 받을 수 있는가. 읽기만 한다. */
async function checkState(ctx: CommandContext, taskId: string, events: readonly AppendEventInput[]): Promise<void> {
  const task = await ctx.store.get('task', { taskId });
  if (task === undefined) throw new TaskNotFoundError(taskId);
  const reasons: string[] = [];
  for (const [i, e] of events.entries()) {
    const at = `events[${i}]`;
    if (task.status !== 'open' && !AFTER_CLOSE.includes(e.type)) reasons.push(`${at}.type: Task ${taskId} 는 ${task.status} 다 — 끝난 Task 에는 ${AFTER_CLOSE.join(', ')} 만 받는다`);
    if (e.step_id !== undefined && (await ctx.store.get('step', { taskId, stepId: e.step_id })) === undefined) reasons.push(`${at}.step_id: ${taskId} 에 ${e.step_id} 가 없다`);
    if (e.run_id !== undefined && (await ctx.store.get('run', { taskId, id: e.run_id })) === undefined) reasons.push(`${at}.run_id: ${taskId} 에 ${e.run_id} 가 없다`);
  }
  if (reasons.length) throw new RejectedInputError(reasons);
}
