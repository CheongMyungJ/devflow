import type { Store } from '../store/types.js';
import { ExecutionError, type Runner, type RunnerRegistry } from '../runner/types.js';

export async function getIntake(ctx: { store: Store; runner: Runner; runners?: RunnerRegistry }, input: { id: string }) {
  const draft = await ctx.store.intake?.get(input.id);
  if (!draft) throw new ExecutionError('Intake draft not found or Store does not support Intake');
  const turn = draft.turns.at(-1);
  if (!turn || turn.status !== 'submitted') return { draft, collected: true };
  const runner = ctx.runners?.get(turn.settings.values.backend!) ?? ctx.runner;
  if (runner.id !== turn.settings.values.backend) throw new ExecutionError('Runner backend mismatch');
  return { draft, collected: false, execution: await runner.inspect({ taskId: draft.id, runId: turn.id, executionId: turn.execution_id }) };
}
