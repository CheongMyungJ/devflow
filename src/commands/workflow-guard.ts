import type { Task } from '../types/generated/index.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';

export function requireUnmanaged(task: Task): void {
  if (task.workflow) throw new RejectedInputError(['Task is controlled by advance; use the current HITL target instead of a record-only transition']);
}
export function requireWorkflowAction(ctx: CommandContext, task: Task, role: string, runId?: string): void {
  if (!task.workflow) return;
  const action = task.workflow.action;
  if (!action || action.id !== ctx.workflowActionId || action.kind !== role || action.run_id !== runId || task.workflow.phase !== role) {
    throw new RejectedInputError(['Task is controlled by advance; no matching reserved action (HITL cannot be bypassed)']);
  }
}
