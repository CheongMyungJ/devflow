import { CommitOutcomeUnknownError } from '../store/errors.js';
import type { NewEvent } from '../store/types.js';
import type { Task } from '../types/generated/index.js';
import type { CommandContext } from './context.js';
import { confirmOutcome } from './outcome.js';

/** 발행 시점에 시스템이 채우는 것(id, status, created_at, created_by, target.task_branch)을 뺀 Task. */
export type CreateTaskInput = Omit<Task, 'id' | 'status' | 'created_at' | 'created_by' | 'target'> & {
  target: Omit<Task['target'], 'task_branch'>;
  /** task branch 이름에 붙일 짧은 설명. `task/T-0001-<slug>`. 없으면 `task/T-0001`. */
  branchSlug?: string;
};

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
 *
 * @throws SchemaViolationError(phase=write) 입력이 Task 스키마를 위반할 때. 그 밖의 Store 오류는 그대로 올라간다 (docs/design/commands.md 2절)
 */
export async function createTask(ctx: CommandContext, input: CreateTaskInput): Promise<Task> {
  const { branchSlug, target, ...rest } = input;
  const slug = branchSlug ? slugify(branchSlug) : '';
  const createdAt = ctx.clock.now().toISOString();
  const event: NewEvent = { type: 'task.created', actor: ctx.actor, at: createdAt, ...(ctx.systemSha ? { system_sha: ctx.systemSha } : {}) };

  // ID 는 Store 가 발급한다. 결과를 알 수 없게 되었을 때 확인하려면 무엇을 보냈는지 알아야 한다.
  let sent: Task | undefined;
  const build = (taskId: string) => {
    sent = {
      ...rest,
      id: taskId,
      target: { ...target, task_branch: slug ? `task/${taskId}-${slug}` : `task/${taskId}` },
      status: 'open',
      created_at: createdAt,
      created_by: ctx.actor,
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
