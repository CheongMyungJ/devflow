import type { Store } from '../store/types.js';
import type { Runner, RunnerRegistry } from '../runner/types.js';
import { ExecutionError } from '../runner/types.js';
import { executionKey, validatedOutput } from '../runner/records.js';

export async function getWorkerExecution(ctx: { store: Store; runner: Runner; runners?: RunnerRegistry; runnerOverride?: string }, input: { taskId: string; runId: string }) {
  const run = await ctx.store.get('run', { taskId: input.taskId, id: input.runId });
  if (!run || run.role !== 'worker' || !run.execution) throw new ExecutionError('managed Worker Run not found');
  if (ctx.runnerOverride && ctx.runnerOverride !== run.backend) throw new ExecutionError('explicit Runner backend mismatch');
  if (ctx.runners) ctx = { ...ctx, runner: ctx.runners.get(run.backend) };
  if (run.backend !== ctx.runner.id) throw new ExecutionError('Runner backend mismatch');
  if (run.status === 'completed') return { run, collected: true, execution: { state: 'completed' as const },
    artifacts: (await ctx.store.list('artifact', { taskId: input.taskId, stepId: run.step_id! })).items.filter((a) => a.run_id === run.id) };
  if (['failed', 'cancelled', 'invalidated'].includes(run.status)) return { run, collected: true, execution: { state: 'failed' as const, kind: run.failure_kind } };
  if (run.status !== 'submitted') throw new ExecutionError(`unsupported managed Run status: ${run.status}`);
  return { run, collected: false, execution: validatedOutput(await ctx.runner.inspect(executionKey(run))) };
}
