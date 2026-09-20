import { randomUUID } from 'node:crypto';
import type { IntakeDraft, IntakeOutput, IntakeTurn, RoleExecutionInput, ExecutionSettings } from '../types/generated/index.js';
import { ExecutionError, type RunRequest } from '../runner/types.js';
import { resolveExecutionSettings } from '../settings/resolve.js';
import { canonical } from '../runner/role-records.js';
import type { WorkerCommandContext } from './worker.js';
import { humanId, rejectIf, schemaIssues } from './common.js';
import { recordedAt } from './time.js';
import { createTask, type CreateTaskInput } from './create-task.js';
import { RejectedInputError } from './errors.js';
import { SchemaViolationError } from '../store/errors.js';
import { getIntake } from '../queries/intake.js';

const event = (ctx: WorkerCommandContext, type: IntakeDraft['events'][number]['type'], extra = {}) => ({ type, actor: ctx.actor, at: recordedAt(ctx.clock), ...extra });
async function save(ctx: WorkerCommandContext, draft: IntakeDraft, previous: number) {
  if (!ctx.store.intake) throw new ExecutionError('Store does not support Intake');
  try { await ctx.store.intake.put(draft, previous); }
  catch (error) { if (canonical(await ctx.store.intake.get(draft.id)) !== canonical(draft)) throw error; }
}
async function load(ctx: WorkerCommandContext, id: string) {
  const draft = await ctx.store.intake?.get(id);
  if (!draft) throw new ExecutionError('Intake draft not found');
  return draft;
}
export async function createIntake(ctx: WorkerCommandContext, input: { text: string }) {
  humanId(ctx);
  if (!input.text.trim()) throw new ExecutionError('Intake text is empty');
  const draft: IntakeDraft = { id: `I-${randomUUID()}`, revision: 1, phase: 'intent', turns: [], events: [event(ctx, 'created', { text: input.text })] };
  await save(ctx, draft, 0);
  return draft;
}
export async function submitIntake(ctx: WorkerCommandContext, input: { id: string; input: RoleExecutionInput }) {
  humanId(ctx);
  rejectIf(schemaIssues('role-execution-input', input.input, 'input'));
  if (input.input.resolved_settings || input.input.artifact_refs || input.input.deterministic) throw new ExecutionError('Intake takes prompt and execution options only');
  let draft = await load(ctx, input.id);
  if (draft.phase === 'issued' || draft.phase === 'publishing') throw new ExecutionError('Intake publication is already in progress or complete');
  let turn = draft.turns.at(-1);
  if (turn && turn.phase === draft.phase && canonical(turn.input) === canonical(input.input) && turn.status !== 'submitted') return getIntake(ctx, { id: draft.id });
  if (turn?.status === 'submitted' && canonical(turn.input) !== canonical(input.input)) throw new ExecutionError('Collect or cancel the active Intake turn before changing input');
  if (turn?.status !== 'submitted') {
    const explicit = Object.fromEntries(['backend', 'model', 'reasoning', 'timeout_seconds', 'isolation', 'output_retries'].filter(k => k in input.input).map(k => [k, (input.input as unknown as Record<string, unknown>)[k]])) as ExecutionSettings;
    const settings = resolveExecutionSettings(ctx.settings ? await ctx.settings.read() : {}, { role: 'intake', explicit });
    turn = { id: `R-${String(draft.turns.length + 1).padStart(3, '0')}`, execution_id: randomUUID(), phase: draft.phase,
      status: 'submitted', input: input.input, settings, submitted_at: recordedAt(ctx.clock),
      context: JSON.stringify({ phase: draft.phase, confirmed_intent: draft.confirmed_intent, events: draft.events, previous_outputs: draft.turns.map(t => t.output).filter(Boolean),
        instructions: draft.phase === 'intent' ? 'Return the seven-field intent draft, without acceptance criteria. Ask unresolved questions in open_questions.' : 'Return a Task definition translating the confirmed intent into acceptance criteria. Preserve all confirmed intent fields.' }) };
  }
  const runner = ctx.runners?.get(turn.settings.values.backend!) ?? ctx.runner;
  if (ctx.runnerOverride && ctx.runnerOverride !== runner.id) throw new ExecutionError('Explicit Runner backend differs from resolved settings');
  if (runner.id !== turn.settings.values.backend || !runner.intakeWorkspace) throw new ExecutionError('Intake execution is unavailable for selected Runner');
  const values = turn.settings.values;
  const request: RunRequest = { key: { taskId: draft.id, runId: turn.id, executionId: turn.execution_id }, workspaceId: draft.id.slice(2),
    workdir: await runner.intakeWorkspace(draft.id, draft.turns.at(-1)?.status !== 'submitted'), role: 'intake', access: 'read', prompt: turn.input.prompt, context: turn.context, backend: runner.id,
    ...(values.model ? { model: values.model } : {}), ...(values.reasoning ? { reasoning: values.reasoning } : {}),
    ...(values.timeout_seconds ? { timeout_seconds: values.timeout_seconds } : {}), ...(values.isolation ? { isolation: values.isolation } : {}),
    ...(values.output_retries !== undefined ? { output_retries: values.output_retries } : {}) };
  if (draft.turns.at(-1)?.status !== 'submitted') {
    await runner.prepare(request);
    const next: IntakeDraft = { ...draft, revision: draft.revision + 1, turns: [...draft.turns, turn], events: [...draft.events, event(ctx, 'submitted', { text: input.input.prompt })] };
    await save(ctx, next, draft.revision); draft = next;
  }
  await runner.submit(request);
  return getIntake({ ...ctx, runner }, { id: draft.id });
}
export async function collectIntake(ctx: WorkerCommandContext, input: { id: string }) {
  const status = await getIntake(ctx, input);
  if (status.collected || !status.execution || !['completed', 'failed'].includes(status.execution.state)) return status;
  const draft = status.draft, turn = draft.turns.at(-1)!;
  let done: IntakeTurn;
  if (status.execution.state === 'failed') done = { ...turn, status: 'failed', failure: status.execution.reason, ended_at: recordedAt(ctx.clock) };
  else if (status.execution.state === 'completed') {
    const output = JSON.parse(status.execution.workerOutput) as IntakeOutput;
    const issues = schemaIssues('intake-output', output, 'output');
    if (output.phase !== turn.phase) issues.push('Output phase does not match the confirmed Intake phase');
    if (output.phase === 'definition' && draft.confirmed_intent && output.definition) {
      for (const [key, value] of Object.entries(draft.confirmed_intent.intent)) if (canonical((output.definition as unknown as Record<string, unknown>)[key]) !== canonical(value)) issues.push(`Definition changed confirmed intent: ${key}`);
    }
    done = issues.length ? { ...turn, status: 'failed', failure: issues.join('; '), ended_at: recordedAt(ctx.clock) } : { ...turn, status: 'completed', output, ended_at: recordedAt(ctx.clock) };
  } else return status;
  await save(ctx, { ...draft, revision: draft.revision + 1, turns: [...draft.turns.slice(0, -1), done], events: [...draft.events, event(ctx, 'collected')] }, draft.revision);
  return getIntake(ctx, input);
}
export async function confirmIntakeIntent(ctx: WorkerCommandContext, input: { id: string; version: number }) {
  humanId(ctx);
  const draft = await load(ctx, input.id), last = draft.turns.at(-1);
  if (draft.phase === 'definition' && draft.confirmed_intent?.revision === input.version) return draft;
  if (draft.revision !== input.version || draft.phase !== 'intent' || last?.status !== 'completed' || !last.output?.intent) throw new ExecutionError('Confirm the current completed intent version');
  if (last.output.intent.open_questions.some(q => q.answered_by === 'human')) throw new ExecutionError('Resolve human questions before confirming intent');
  const next: IntakeDraft = { ...draft, phase: 'definition', revision: draft.revision + 1,
    confirmed_intent: { revision: input.version, intent: last.output.intent }, events: [...draft.events, event(ctx, 'intent_confirmed', { version: input.version })] };
  await save(ctx, next, draft.revision); return next;
}
export async function publishIntake(ctx: WorkerCommandContext, input: { id: string; version: number }) {
  humanId(ctx);
  let draft = await load(ctx, input.id);
  if (draft.phase === 'issued') {
    if (!draft.events.some(e => e.type === 'issued' && e.version === input.version)) throw new ExecutionError('This is not the published definition version');
    return draft;
  }
  const source = `intake://${draft.id}@v${input.version}`;
  if (draft.phase === 'publishing') {
    if (draft.events.at(-1)?.type !== 'publish_requested' || draft.events.at(-1)?.version !== input.version) throw new ExecutionError('This is not the pending publication version');
    // Reconcile an interrupted publication from its committed Task provenance.
    for (const task of (await ctx.store.list('task', {})).items) {
      if ((await ctx.store.readEvents(task.id)).some(e => e.type === 'task.created' && (e.data as Record<string, unknown> | undefined)?.['intake'] === source)) {
        const next: IntakeDraft = { ...draft, phase: 'issued', task_id: task.id, revision: draft.revision + 1, events: [...draft.events, event(ctx, 'issued', { version: input.version })] };
        await save(ctx, next, draft.revision); return next;
      }
    }
    throw new ExecutionError('Publication outcome is not confirmed; inspect the existing attempt before issuing another Task');
  }
  const output = draft.turns.at(-1)?.output;
  if (draft.phase !== 'definition' || draft.revision !== input.version || !output?.definition || !draft.confirmed_intent || draft.turns.at(-1)?.status !== 'completed') throw new ExecutionError('Confirm the current completed definition version');
  const pending: IntakeDraft = { ...draft, phase: 'publishing', revision: draft.revision + 1, events: [...draft.events, event(ctx, 'publish_requested', { version: input.version })] };
  await save(ctx, pending, draft.revision); draft = pending;
  let task;
  try { task = await createTask(ctx, { ...output.definition, createdData: { intake: source } } as CreateTaskInput); }
  catch (error) {
    // These rejections prove that no Task was created. Unknown outcomes remain fenced.
    if (error instanceof RejectedInputError || (error instanceof SchemaViolationError && error.phase === 'write')) {
      await save(ctx, { ...draft, phase: 'definition', revision: draft.revision + 1, events: [...draft.events, event(ctx, 'publish_rejected', { text: error.message })] }, draft.revision);
    }
    throw error;
  }
  const done: IntakeDraft = { ...draft, phase: 'issued', task_id: task.id, revision: draft.revision + 1, events: [...draft.events, event(ctx, 'issued', { version: input.version })] };
  await save(ctx, done, draft.revision); return done;
}
export async function cancelIntake(ctx: WorkerCommandContext, input: { id: string }) {
  humanId(ctx);
  const status = await getIntake(ctx, input); if (status.collected) return status;
  const draft = status.draft, turn = draft.turns.at(-1)!;
  const runner = ctx.runners?.get(turn.settings.values.backend!) ?? ctx.runner;
  if (!runner.cancel) throw new ExecutionError('Cancellation unavailable');
  if (draft.events.at(-1)?.type !== 'cancel_requested') await save(ctx, { ...draft, revision: draft.revision + 1, events: [...draft.events, event(ctx, 'cancel_requested')] }, draft.revision);
  await runner.cancel({ taskId: draft.id, runId: turn.id, executionId: turn.execution_id });
  return getIntake(ctx, input);
}
