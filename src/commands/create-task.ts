import { CommitOutcomeUnknownError } from '../store/errors.js';
import type { NewEvent } from '../store/types.js';
import type { Task } from '../types/generated/index.js';
import { humanId } from './common.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { confirmOutcome } from './outcome.js';
import { recordedAt } from './time.js';

/** 발행 시점에 시스템이 채우는 것(id, status, created_at, created_by, target.task_branch)을 뺀 Task. */
export type CreateTaskInput = Omit<Task, 'id' | 'status' | 'created_at' | 'created_by' | 'target'> & {
  target: Omit<Task['target'], 'task_branch'>;
  /** task branch 이름에 붙일 짧은 설명. `task/T-0001-<slug>`. 없으면 `task/T-0001`. */
  branchSlug?: string;
  /** task.created 의 data — 발행의 출처(backlog 항목), Intake 의 방식, 경위(note). 옛 기록에 있던 자리다. 없으면 data 를 쓰지 않는다. */
  createdData?: { backlog?: string; intake?: string; note?: string };
};

/** 입력에 둘 수 없는 것 — 도구가 채운다(docs/design/commands.md 6.2). 타입이 막지만 입구는 사람이 쓴 파일을 그대로 넘긴다. */
const TOOL_FILLED = ['id', 'status', 'created_at', 'created_by'] as const;
const CREATED_DATA_KEYS = ['backlog', 'intake', 'note'];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Task 를 발행한다. Task 와 task.created 이벤트가 함께 기록되거나 아무것도 기록되지 않는다.
 * 멱등이 아니다: 두 번 부르면 Task 가 두 개 생긴다.
 * 시각은 초 단위 UTC(recordedAt), task.yaml 의 created_by 는 사람의 id(`human:` 을 뗀 것 — 옛 기록과 같은 모양), 이벤트의 actor 는 `human:<id>`
 * 그대로다(T-0006 F-001 (3)). 사람만 발행한다.
 *
 * @throws RejectedInputError actor 가 human:<id> 가 아니거나, 입력에 도구가 채우는 필드(id, status, created_at, created_by, target.task_branch)나
 *   createdData 의 모르는 필드가 있을 때. SchemaViolationError(phase=write) 입력이 Task 스키마를 위반할 때(사람이 답할 질문이 남은 open_questions 포함).
 *   그 밖의 Store 오류는 그대로 올라간다 (docs/design/commands.md 2절)
 */
export async function createTask(ctx: CommandContext, input: CreateTaskInput): Promise<Task> {
  const createdBy = humanId(ctx);
  const reasons = [
    ...TOOL_FILLED.filter((k) => k in input).map((k) => `${k}: 도구가 채우는 필드다 — Task 정의에 두지 않는다`),
    ...(input.target !== null && typeof input.target === 'object' && 'task_branch' in input.target ? ['target.task_branch: 도구가 채우는 필드다 — Task 정의에 두지 않는다'] : []),
    ...Object.keys(input.createdData ?? {})
      .filter((k) => !CREATED_DATA_KEYS.includes(k))
      .map((k) => `createdData.${k}: 모르는 입력이다 (받는 것: ${CREATED_DATA_KEYS.join(', ')})`),
  ];
  if (reasons.length) throw new RejectedInputError(reasons);

  const { branchSlug, createdData, target, ...rest } = input;
  const slug = branchSlug ? slugify(branchSlug) : '';
  const createdAt = recordedAt(ctx.clock);
  const data = Object.fromEntries(Object.entries(createdData ?? {}).filter(([, v]) => v !== undefined));
  const event: NewEvent = {
    type: 'task.created',
    actor: ctx.actor,
    ...(Object.keys(data).length ? { data } : {}),
    ...(ctx.systemSha ? { system_sha: ctx.systemSha } : {}),
    at: createdAt,
  };

  // ID 는 Store 가 발급한다. 결과를 알 수 없게 되었을 때 확인하려면 무엇을 보냈는지 알아야 한다.
  let sent: Task | undefined;
  const build = (taskId: string) => {
    sent = {
      ...rest,
      id: taskId,
      target: { ...target, task_branch: slug ? `task/${taskId}-${slug}` : `task/${taskId}` },
      status: 'open',
      created_at: createdAt,
      created_by: createdBy,
    };
    return { task: sent, events: [event] as [NewEvent] };
  };

  try {
    return (await ctx.store.createTask(build)).task;
  } catch (error) {
    if (!(error instanceof CommitOutcomeUnknownError) || sent?.id !== error.taskId) throw error;
    // commit 식별자로 판정한다 (docs/design/commands.md 3절). 실패한 발행의 ID 가 다른 호출자에게 다시 발급되어 같은 행위자·같은 시각의
    // task.created 가 그 자리에 있어도 식별자가 다르면 성립하지 않은 것이다. Task 와 이벤트는 한 commit 으로 원자적으로 기록되므로
    // 자기 식별자의 이벤트가 있으면 보낸 Task 도 기록되었다 — 저장된 Task 를 보낸 것과 비교하지 않는다.
    await confirmOutcome(ctx.store, error, [event]);
    return sent;
  }
}
