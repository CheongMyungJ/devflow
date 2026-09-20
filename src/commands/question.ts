import { randomUUID } from 'node:crypto';
import type { HitlTarget, QuestionSettings } from '../types/generated/index.js';
import { resolveExecutionSettings } from '../settings/resolve.js';
import { blobRef } from '../store/blob-ref.js';
import { ExecutionError } from '../runner/types.js';
import { getWorkflow } from '../queries/workflow.js';
import { getWorkspace } from '../queries/workspace.js';
import { checkKeys, commitAfterReading, humanId, openTask, rejectIf, sameJson, schemaIssues, tail } from './common.js';
import type { WorkerCommandContext } from './worker.js';
import { recordedAt } from './time.js';

export async function openQuestion(ctx: WorkerCommandContext, input: { taskId: string; target: HitlTarget; text: string } & QuestionSettings) {
  checkKeys(input, ['taskId', 'target', 'text', 'backend', 'model', 'reasoning']); humanId(ctx);
  rejectIf(schemaIssues('hitl-target', input.target, 'target'));
  if (!input.text?.trim()) throw new ExecutionError('Initial question is required');
  if (input.target.role === 'artifact') throw new ExecutionError('Open questions at a role result HITL');
  const task = await openTask(ctx, input.taskId);
  if (!sameJson(task.workflow?.pending, input.target)) throw new ExecutionError('Question target is stale');
  const run = input.target.run_id ? await ctx.store.get('run', { taskId: task.id, id: input.target.run_id }) : undefined;
  const material = await getWorkflow(ctx, task.id);
  const workspace = await getWorkspace(ctx, task.id);
  if (workspace.state !== 'ready') throw new ExecutionError('Question snapshot requires the Task workspace identity to remain available');
  const explicit = Object.fromEntries(['backend', 'model', 'reasoning'].filter(key => key in input).map(key => [key, input[key as keyof QuestionSettings]]));
  rejectIf(schemaIssues('question-settings', explicit, 'question settings'));
  const confirmedStep = material.step && !['proposed', 'cancelled'].includes(material.step.status) ? material.step : undefined;
  const settings = resolveExecutionSettings(ctx.settings ? await ctx.settings.read(workspace.location.workdir) : {}, {
    role: 'question', taskType: confirmedStep?.task_type ?? task.type,
    ...(confirmedStep?.execution?.question ? { step: confirmedStep.execution.question } : {}), explicit,
  });
  const { backend = 'codex', model, reasoning } = settings.values;
  const runner = ctx.runners?.get(backend) ?? ctx.runner;
  if (runner.id !== backend || !runner.openQuestion) throw new ExecutionError(`Independent read-only question CLI is unsupported for ${backend}`);
  const code: Array<{ repo: string; sha: string; files: Array<{ path: string; base64: string }> }> = [];
  if (run?.execution?.pinned_code) {
    if (!ctx.workspace.snapshot) throw new ExecutionError('Workspace cannot provide immutable code snapshots');
    const pinned = run.execution.pinned_code;
    code.push({ repo: pinned.repo, sha: pinned.head_sha, files: await ctx.workspace.snapshot(pinned.repo, pinned.head_sha) });
  }
  for (const { artifact } of material.artifacts) {
    if (!artifact.code || code.some(c => c.repo === artifact.code!.repo && c.sha === artifact.code!.head_sha)) continue;
    if (!ctx.workspace.snapshot) throw new ExecutionError('Workspace cannot provide immutable code snapshots');
    code.push({ repo: artifact.code.repo, sha: artifact.code.head_sha, files: await ctx.workspace.snapshot(artifact.code.repo, artifact.code.head_sha) });
  }
  const packet = run ? await ctx.store.getBlob(blobRef({ taskId: task.id, ...(run.step_id ? { stepId: run.step_id } : {}), runId: run.id }, 'packet')) : undefined;
  const context = JSON.stringify({ at: recordedAt(ctx.clock), task, target: input.target, material, code, resolved_settings: settings,
    ...(packet ? { original_context: new TextDecoder().decode(packet) } : {}),
    decisions: (await ctx.store.list('decision', { taskId: task.id })).items,
    gates: (await ctx.store.list('gate_result', { taskId: task.id })).items,
    feedback: (await ctx.store.list('feedback', { taskId: task.id })).items,
    notice: '질문 시점의 결과 기준. 기록된 내용만 설명하며 원래 세션의 기록되지 않은 사고 과정은 알 수 없습니다. 원본 작업공간의 최신 내용은 포함하지 않습니다.' });
  const id = randomUUID();
  await commitAfterReading(ctx, task.id, async () => {
    const current = await openTask(ctx, task.id);
    if (!sameJson(current.workflow?.pending, input.target)) throw new ExecutionError('Question target changed while preparing the snapshot');
    return () => ({ events: [{ type: 'question.requested', actor: ctx.actor, data: { id, backend, resolved_settings: settings, target: input.target, text: input.text }, ...tail(ctx, recordedAt(ctx.clock)) }] });
  });
  let handedOff = false, error: string | undefined;
  try { await runner.openQuestion({ id, workdir: workspace.location.workdir, question: input.text, context, ...(model != null ? { model } : {}), ...(reasoning != null ? { reasoning } : {}) }); handedOff = true; }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  // Task may have advanced or finished during handoff. This event never writes its mutable state.
  await commitAfterReading(ctx, task.id, async () => () => ({ events: [{ type: handedOff ? 'question.handed_off' : 'question.failed', actor: 'system', data: { id, backend, target: input.target }, ...tail(ctx, recordedAt(ctx.clock)) }] }));
  return { handedOff, id, settings, ...(error ? { error } : {}), notice: handedOff ? '질문 CLI 실행을 인계했습니다. devflow는 대화·종료·답변을 수집하지 않으며 지금 승인/수정 요청을 할 수 있습니다.' : '질문 CLI 인계에 실패했습니다. Task 상태는 변경하지 않았습니다.' };
}
