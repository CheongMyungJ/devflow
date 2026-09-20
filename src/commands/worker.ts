import { randomUUID } from 'node:crypto';
import type { WorkerExecutionInput, ExecutionSettings } from '../types/generated/index.js';
import type { RunnerRegistry } from '../runner/types.js';
import type { ExecutionSettingsSource } from '../settings/types.js';
import { resolveExecutionSettings } from '../settings/resolve.js';
import { blobRef } from '../store/blob-ref.js';
import { ExecutionError, type Runner, type RunRequest } from '../runner/types.js';
import { executionInput, executionKey, inputDigest, outputNotes, validatedOutput } from '../runner/records.js';
import { getWorkspace } from '../queries/workspace.js';
import { getWorkerExecution } from '../queries/worker.js';
import { requireWorkflowAction } from './workflow-guard.js';
import { isCanonicalId, isTaskId } from '../store/refs.js';
import { checkKeys, openTask, rejectIf, schemaIssues } from './common.js';
import { submitRun, completeRun, failRun } from './runs.js';
import type { WorkspaceCommandContext } from './workspace.js';

export interface WorkerCommandContext extends WorkspaceCommandContext { runner: Runner; settings?: ExecutionSettingsSource; runners?: RunnerRegistry; runnerOverride?: string }
export interface SubmitWorkerInput { taskId: string; stepId: string; runId: string; input: WorkerExecutionInput }

/** Multi-stage command: local prepare → shared submit → external start. Never rollback an external action. */
export async function submitWorker(ctx: WorkerCommandContext, input: SubmitWorkerInput) {
  requireWorkflowAction(ctx, await openTask(ctx, input.taskId), 'worker', input.runId);
  if (!ctx.settings) return submitResolvedWorker(ctx, input);
  rejectIf(schemaIssues('worker-execution-input', input.input, 'input'));
  if (input.input.resolved_settings || input.input.context_packet) throw new ExecutionError('resolved_settings and context_packet are system-owned');
  const originalDigest = inputDigest(input.input);
  const saved = await ctx.store.get('run', { taskId: input.taskId, id: input.runId });
  if (saved) {
    const expected = saved.execution?.request_sha256 ?? saved.execution?.input_sha256;
    if (expected !== originalDigest) throw new ExecutionError('existing Run has different input');
    const frozen = await executionInput(ctx.store, saved);
    return submitResolvedWorker({ ...ctx, runner: ctx.runners?.get(saved.backend) ?? ctx.runner }, { ...input, input: frozen }, originalDigest);
  }
  const task = await openTask(ctx, input.taskId);
  const workspace = await getWorkspace(ctx, input.taskId);
  if (workspace.state !== 'ready') throw new ExecutionError('Task Workspace is not ready');
  const step = await ctx.store.get('step', { taskId: input.taskId, stepId: input.stepId });
  const explicit = Object.fromEntries(['backend', 'model', 'reasoning', 'timeout_seconds', 'isolation', 'output_retries'].filter(k => k in input.input).map(k => [k, (input.input as unknown as Record<string, unknown>)[k]])) as ExecutionSettings;
  const resolved = resolveExecutionSettings(await ctx.settings.read(workspace.location.workdir), {
    role: 'worker', taskType: step?.task_type ?? task.type, ...(step?.execution?.worker ? { step: step.execution.worker } : {}), explicit,
  });
  const { model, ...values } = resolved.values;
  const artifacts = (await ctx.store.list('artifact', { taskId: input.taskId, stepId: input.stepId })).items;
  if (step?.status === 'revising') {
    if (task.workflow && workspace.location.dirty) throw new ExecutionError('Revision worktree has uncollected changes; reconcile them before starting a new Worker');
    const code = artifacts.filter(a => a.code).sort((a, b) => b.version - a.version)[0]?.code;
    if (code && (workspace.location.head !== code.head_sha || workspace.location.dirty)) throw new ExecutionError('Revision workspace differs from the recorded Artifact; reconcile current changes before starting a new Worker');
  }
  const previousRuns = (await ctx.store.list('run', { taskId: input.taskId, stepId: input.stepId, role: 'worker' })).items;
  const previousNotes = [];
  for (const previous of previousRuns.filter(r => r.status === 'completed')) {
    const bytes = await ctx.store.getBlob(blobRef({ taskId: input.taskId, stepId: input.stepId, runId: previous.id }, 'work-notes'));
    if (bytes) previousNotes.push({ run: previous.id, text: new TextDecoder().decode(bytes) });
  }
  const packet = JSON.stringify({ task, step, artifacts, previousNotes,
    decisions: (await ctx.store.list('decision', { taskId: input.taskId })).items,
    feedback: (await ctx.store.list('feedback', { taskId: input.taskId })).items,
    gates: (await ctx.store.list('gate_result', { taskId: input.taskId, stepId: input.stepId })).items,
    instruction: 'This is a new session. Preserve earlier commits; revisions create a new Artifact version. Report missing Context in packet_gaps.' });
  return submitResolvedWorker({ ...ctx, runner: ctx.runners?.get(values.backend!) ?? ctx.runner },
    { ...input, input: { prompt: input.input.prompt, artifacts: input.input.artifacts, ...values, ...(model != null ? { model } : {}), resolved_settings: resolved, context_packet: packet } }, originalDigest);
}

async function submitResolvedWorker(ctx: WorkerCommandContext, input: SubmitWorkerInput, originalDigest?: string) {
  try {
    checkKeys(input, ['taskId', 'stepId', 'runId', 'input']);
    if (ctx.runnerOverride && ctx.runnerOverride !== ctx.runner.id) throw new ExecutionError('Explicit Runner backend differs from resolved settings');
    rejectIf(schemaIssues('worker-execution-input', input.input, 'input'));
    if ((input.input.backend ?? 'fake') !== ctx.runner.id) throw new ExecutionError('explicit input backend must match selected Runner (omission means fake)');
    if (!isTaskId(input.taskId) || !isCanonicalId('run', input.runId) || !isCanonicalId('step', input.stepId)) throw new ExecutionError('invalid Task/Step/Run identity');
    const digest = inputDigest(input.input);
    let run = await ctx.store.get('run', { taskId: input.taskId, id: input.runId });
    if (run) {
      if (run.role !== 'worker' || run.step_id !== input.stepId || run.backend !== ctx.runner.id || run.execution?.input_sha256 !== digest) throw new ExecutionError('existing Run has different input, Step, backend or execution ownership');
      if (run.status !== 'submitted') return getWorkerExecution(ctx, input);
    }
    await openTask(ctx, input.taskId);
    const workspace = await getWorkspace(ctx, input.taskId);
    if (workspace.state !== 'ready') throw new ExecutionError('Task Workspace is not ready; prepare/inspect Workspace first');
    if (run && run.execution!.workspace_id !== workspace.preparation.workspace_id) throw new ExecutionError('Workspace identity mismatch');
    // Validate the caller's artifact mapping before creating a process.
    const step = await ctx.store.get('step', { taskId: input.taskId, stepId: input.stepId });
    if (!step) throw new ExecutionError('Step not found');
    const names = input.input.artifacts.map((a) => a.name);
    if (new Set(names).size !== names.length || names.length !== step.outputs.length || step.outputs.some((o) => !names.includes(o.name))) throw new ExecutionError('artifact mapping must match Step outputs exactly');
    for (const artifact of input.input.artifacts) {
      const type = step.outputs.find((o) => o.name === artifact.name)!.type;
      if (((artifact.source.startsWith('code:') || artifact.source === 'workspace:code') && type !== 'code_change') || (artifact.source.startsWith('blob:') && type === 'code_change')) throw new ExecutionError('artifact source/type mismatch');
      if (ctx.runner.id !== 'fake' && /^(code|repo):/.test(artifact.source)) throw new ExecutionError('real Workers require workspace:code or blob:work-notes; preclaimed SHA is not execution evidence');
      if (artifact.source.startsWith('repo:')) {
        const paths = artifact.source.slice(artifact.source.indexOf(':', 5) + 1).split(',');
        if (paths.some((p) => !p || /[\\:\x00-\x1f]/.test(p) || p.split('/').some((part) => !part || part === '.' || part === '..'))) throw new ExecutionError('artifact paths must be repository-relative');
      }
    }
    const key = run ? executionKey(run) : { taskId: input.taskId, runId: input.runId, executionId: ctx.workflowActionId ?? randomUUID() };
    const request: RunRequest = { key, workspaceId: workspace.preparation.workspace_id, workdir: workspace.location.workdir,
      role: 'worker', access: 'write', prompt: input.input.prompt,
      ...(input.input.context_packet ? { context: input.input.context_packet } : {}),
      ...(input.input.backend !== undefined ? { backend: input.input.backend } : {}),
      ...(input.input.model != null ? { model: input.input.model } : {}),
      ...(input.input.reasoning != null ? { reasoning: input.input.reasoning } : {}),
      ...(input.input.timeout_seconds !== undefined ? { timeout_seconds: input.input.timeout_seconds } : {}),
      ...(input.input.isolation !== undefined ? { isolation: input.input.isolation } : {}),
      ...(input.input.output_retries !== undefined ? { output_retries: input.input.output_retries } : {}),
      ...(input.input.artifacts.some((a) => a.source === 'workspace:code') ? {
        codeArtifact: { baseSha: workspace.preparation.base_sha, branch: workspace.preparation.task_branch },
      } : {}),
    };
    if (!run) {
      await ctx.runner.prepare(request);
      ({ run } = await submitRun(ctx, {
        taskId: input.taskId, stepId: input.stepId, expectId: input.runId, role: 'worker', purpose: 'execute', access: 'write',
        backend: ctx.runner.id, backendVersion: ctx.runner.version, sessionPath: 'new', performer: 'isolated_session',
        ...(input.input.model != null ? { model: input.input.model } : {}),
        ...(input.input.reasoning !== undefined ? { reasoning: input.input.reasoning } : {}),
        ...(input.input.resolved_settings ? { resolvedSettings: input.input.resolved_settings } : {}),
        ...(input.input.context_packet ? { packet: input.input.context_packet } : {}),
        execution: { id: key.executionId, workspace_id: request.workspaceId, input_sha256: digest, ...(originalDigest ? { request_sha256: originalDigest } : {}) }, executionInput: input.input,
      }));
    }
    await ctx.runner.submit(request);
    return await getWorkerExecution(ctx, input);
  } catch (cause) {
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** Terminal Run is the collection receipt. No local "collected" flag or second commit is needed. */
export async function collectWorker(ctx: WorkerCommandContext, input: { taskId: string; runId: string }) {
  try {
    if (ctx.runners) {
      const run = await ctx.store.get('run', { taskId: input.taskId, id: input.runId });
      if (run) ctx = { ...ctx, runner: ctx.runners.get(run.backend) };
    }
    checkKeys(input, ['taskId', 'runId']);
    const status = await getWorkerExecution(ctx, input);
    if (status.collected) return status;
    const state = validatedOutput(await ctx.runner.inspect(executionKey(status.run)));
    if (state.state === 'failed') {
      await failRun(ctx, { ...input, reason: state.reason, failureKind: state.kind, receipt: state });
    } else if (state.state === 'completed') {
      const spec = await executionInput(ctx.store, status.run);
      const notes = outputNotes(state.workerOutput);
      if (notes === undefined && spec.artifacts.some((a) => a.source === 'blob:work-notes')) {
        await failRun(ctx, { ...input, reason: 'Worker output lacks work_notes required by artifact mapping', failureKind: 'invalid_output' });
      } else {
        if (spec.artifacts.some((a) => a.source === 'workspace:code') && !state.code) throw new ExecutionError('terminal receipt lacks verified code artifact; manual inspection required');
        const artifacts = spec.artifacts.map((a) => a.source === 'workspace:code'
          ? { ...a, source: `code:${state.code!.base_sha}..${state.code!.head_sha}` } : a);
        await completeRun(ctx, { ...input, workerOutput: state.workerOutput, artifacts, receipt: state,
          ...(notes !== undefined ? { workNotes: notes } : {}), outputAttempts: state.outputAttempts ?? 1 });
      }
    }
    return await getWorkerExecution(ctx, input);
  } catch (cause) {
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
