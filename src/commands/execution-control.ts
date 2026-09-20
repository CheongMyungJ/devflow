import { randomUUID } from 'node:crypto';
import { executionKey } from '../runner/records.js';
import { ExecutionError } from '../runner/types.js';
import type { NewEvent } from '../store/types.js';
import type { WorkerCommandContext } from './worker.js';
import { commitAfterReading, humanId, tail } from './common.js';
import { recordedAt } from './time.js';
import { getExecution } from '../queries/execution.js';

class AlreadyRecorded extends Error {}
async function recordOnce(ctx: WorkerCommandContext, taskId: string, runId: string, type: NewEvent['type'], id: string, data: Record<string, unknown>) {
  try {
    await commitAfterReading(ctx, taskId, async () => {
      const previous = (await ctx.store.readEvents(taskId)).find(e => e.type === type && e.run_id === runId && (e.data as Record<string, unknown> | undefined)?.['request_id'] === id);
      if (previous) {
        if ((previous.data as Record<string, unknown> | undefined)?.['text'] !== data['text']) throw new ExecutionError('request ID already has different text');
        throw new AlreadyRecorded();
      }
      const run = await ctx.store.get('run', { taskId, id: runId });
      if (!run?.execution || run.status !== 'submitted') throw new ExecutionError('execution is no longer active');
      return () => ({ events: [{ type, actor: ctx.actor, run_id: runId, ...(run.step_id ? { step_id: run.step_id } : {}), data: { ...data, request_id: id }, ...tail(ctx, recordedAt(ctx.clock)) }] });
    });
  } catch (error) { if (!(error instanceof AlreadyRecorded)) throw error; }
}
export async function cancelExecution(ctx: WorkerCommandContext, input: { taskId: string; runId: string }) {
  humanId(ctx);
  const status = await getExecution(ctx, input);
  if (status.collected) return status;
  const runner = ctx.runners?.get(status.run.backend) ?? ctx.runner;
  if (!runner.cancel) throw new ExecutionError('cancel capability unavailable');
  await recordOnce(ctx, input.taskId, input.runId, 'run.cancel_requested', status.run.execution!.id, {});
  await runner.cancel(executionKey(status.run));
  return getExecution(ctx, input);
}
export async function sendExecutionMessage(ctx: WorkerCommandContext, input: { taskId: string; runId: string; text: string; messageId?: string }) {
  humanId(ctx);
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100000) throw new ExecutionError('message text is empty or too long');
  const status = await getExecution(ctx, input);
  if (status.run.role === 'reviewer') throw new ExecutionError('Reviewer cannot receive live intervention; leave feedback on its result');
  const runner = ctx.runners?.get(status.run.backend) ?? ctx.runner;
  if (!runner.capabilities.supportsLiveMessage || !runner.message) throw new ExecutionError('Backend does not support live messages; request a follow-up after confirmed completion');
  const id = input.messageId ?? randomUUID();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new ExecutionError('invalid message ID');
  await recordOnce(ctx, input.taskId, input.runId, 'run.message_sent', id, { text: input.text, delivery: 'pending' });
  return { messageId: id, ...await runner.message(executionKey(status.run), { id, text: input.text }) };
}
