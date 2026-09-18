import type { SchemaIssue } from '../store/errors.js';
import type { Store } from '../store/types.js';
import type { Task } from '../types/generated/index.js';

export interface QueryContext {
  store: Store;
}

export interface TaskFilter {
  status?: Task['status'];
}

export interface TaskList {
  /** ID 순. */
  tasks: Task[];
  /** 저장되어 있으나 읽지 못한 Task. 숨기지 않는다: 사용자가 목록에 없는 이유를 알 수 있어야 한다. */
  unreadable: Array<{ subject: string; issues: SchemaIssue[] }>;
}

/** 없으면 undefined. 저장된 Task 가 손상되었으면 SchemaViolationError(phase=read). */
export function getTask(ctx: QueryContext, taskId: string): Promise<Task | undefined> {
  return ctx.store.get('task', { taskId });
}

export async function listTasks(ctx: QueryContext, filter: TaskFilter = {}): Promise<TaskList> {
  const { items, invalid } = await ctx.store.list('task', filter.status === undefined ? {} : { status: filter.status });
  return { tasks: items, unreadable: invalid.map(({ subject, issues }) => ({ subject, issues })) };
}
