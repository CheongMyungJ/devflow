import type { Store } from '../store/types.js';
import { ExecutionError, type Runner, type RunnerRegistry } from '../runner/types.js';
import { executionKey } from '../runner/records.js';
import { validatedRoleOutput } from '../runner/role-records.js';
import { getWorkerExecution } from './worker.js';

export interface ExecutionQueryContext { store: Store; runner: Runner; runners?: RunnerRegistry; runnerOverride?: string }
export async function getExecution(ctx: ExecutionQueryContext, input: { taskId: string; runId: string }) {
  const run = await ctx.store.get('run', { taskId: input.taskId, id: input.runId });
  if (!run?.execution) throw new ExecutionError('managed Run not found');
  if (ctx.runnerOverride && ctx.runnerOverride !== run.backend) throw new ExecutionError('explicit Runner backend mismatch');
  if (run.role === 'worker') return getWorkerExecution(ctx, input);
  if (run.status !== 'submitted') {
    const decisions = run.role === 'planner' ? (await ctx.store.list('decision', { taskId: input.taskId })).items.filter(d => d.planner_run_id === run.id) : [];
    const gates = run.role === 'reviewer' ? (await ctx.store.list('gate_result', { taskId: input.taskId, stepId: run.step_id! })).items.filter(g => g.reviewer_run_id === run.id) : [];
    return { run, collected: true, execution: { state: run.status === 'completed' ? 'completed' as const : 'failed' as const }, decisions, gates };
  }
  const runner = ctx.runners?.get(run.backend) ?? ctx.runner;
  if (runner.id !== run.backend) throw new ExecutionError('Runner backend mismatch');
  return { run, collected: false, execution: validatedRoleOutput(await runner.inspect(executionKey(run)), run.role) };
}
export async function getExecutionLog(ctx: ExecutionQueryContext, input: { taskId: string; runId: string; offset?: number; limit?: number }) {
  const run = await ctx.store.get('run', { taskId: input.taskId, id: input.runId });
  if (!run?.execution) throw new ExecutionError('managed Run not found');
  const runner = ctx.runners?.get(run.backend) ?? ctx.runner;
  if (runner.id !== run.backend || !runner.logs) throw new ExecutionError('Runner log capability unavailable');
  return runner.logs(executionKey(run), input);
}
