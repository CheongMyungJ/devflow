import { randomUUID } from 'node:crypto';
import type { ArtifactVersion, ExecutionSettings, RoleExecutionInput } from '../types/generated/index.js';
import type { BlobRef } from '../store/types.js';
import { ExecutionError, type RunRequest } from '../runner/types.js';
import { executionKey } from '../runner/records.js';
import { roleDigest, roleInput, validatedRoleOutput } from '../runner/role-records.js';
import { resolveExecutionSettings } from '../settings/resolve.js';
import { blobRef } from '../store/blob-ref.js';
import { getWorkspace } from '../queries/workspace.js';
import { getExecution } from '../queries/execution.js';
import { checkArtifactRef, checkKeys, openTask, rejectIf, schemaIssues } from './common.js';
import { failRun, submitRun } from './runs.js';
import { recordDecision } from './plan.js';
import { recordGate } from './gates.js';
import { collectWorker, type WorkerCommandContext } from './worker.js';

export interface SubmitRoleInput { taskId: string; stepId?: string; runId: string; role: 'planner' | 'reviewer'; input: RoleExecutionInput }
export async function submitRole(ctx: WorkerCommandContext, input: SubmitRoleInput) {
  checkKeys(input, ['taskId', 'stepId', 'runId', 'role', 'input']);
  rejectIf(schemaIssues('role-execution-input', input.input, 'input'));
  if (input.input.resolved_settings) throw new ExecutionError('resolved_settings is system-owned');
  if (!['planner', 'reviewer'].includes(input.role) || (input.role === 'reviewer') !== (input.stepId !== undefined)) throw new ExecutionError('Reviewer requires a Step; Planner is Task-scoped');
  const originalDigest = roleDigest(input.input);
  let run = await ctx.store.get('run', { taskId: input.taskId, id: input.runId });
  if (run && (run.role !== input.role || run.step_id !== input.stepId || run.execution?.request_sha256 !== originalDigest)) throw new ExecutionError('existing Run has different role, Step or input');
  if (run && run.status !== 'submitted') return getExecution(ctx, input);
  const task = await openTask(ctx, input.taskId);
  const workspace = await getWorkspace(ctx, input.taskId);
  if (workspace.state !== 'ready') throw new ExecutionError('Task Workspace is not ready');
  const step = input.stepId ? await ctx.store.get('step', { taskId: input.taskId, stepId: input.stepId }) : undefined;
  if (input.role === 'reviewer' && !step) throw new ExecutionError('Reviewer Step not found');
  let spec: RoleExecutionInput, packet: string;
  if (run) {
    if (run.execution!.workspace_id !== workspace.preparation.workspace_id) throw new ExecutionError('Workspace identity mismatch');
    spec = await roleInput(ctx.store, run);
    const bytes = await ctx.store.getBlob(blobRef({ taskId: run.task_id, ...(run.step_id ? { stepId: run.step_id } : {}), runId: run.id }, 'packet'));
    if (!bytes) throw new ExecutionError('frozen Context is missing');
    packet = new TextDecoder().decode(bytes);
  } else {
    const artifacts: ArtifactVersion[] = [];
    if (input.role === 'reviewer') {
      if (!input.input.artifact_refs?.length) throw new ExecutionError('Reviewer requires explicit Artifact versions');
      const reasons: string[] = [];
      for (const ref of input.input.artifact_refs) {
        await checkArtifactRef(ctx, ref, { taskId: input.taskId, stepId: input.stepId! }, 'artifact_refs', reasons);
        const artifact = await ctx.store.get('artifact', { ref });
        if (artifact) artifacts.push(artifact);
      }
      rejectIf(reasons);
      for (const artifact of artifacts) {
        if (artifact.code && (artifact.code.repo !== task.target.repo || artifact.code.branch !== workspace.preparation.task_branch || artifact.code.head_sha !== workspace.location.head || workspace.location.dirty)) {
          throw new ExecutionError('Reviewer workspace differs from the pinned Artifact version; reconcile the workspace before review');
        }
      }
    }
    const artifactContents = [];
    for (const artifact of artifacts) {
      for (const key of new Set([artifact.content_key, artifact.work_notes_key].filter((key): key is string => Boolean(key)))) {
        const bytes = await ctx.store.getBlob(key as BlobRef);
        if (!bytes) throw new ExecutionError(`Artifact Context is missing: ${key}`);
        artifactContents.push({ artifact: artifact.ref, source: key, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
      }
    }
    const explicit = Object.fromEntries(['backend', 'model', 'reasoning', 'timeout_seconds', 'isolation', 'output_retries'].filter(k => k in input.input).map(k => [k, (input.input as unknown as Record<string, unknown>)[k]])) as ExecutionSettings;
    const settings = resolveExecutionSettings(ctx.settings ? await ctx.settings.read(workspace.location.workdir) : {}, {
      role: input.role, taskType: step?.task_type ?? task.type, ...(step?.execution?.[input.role] ? { step: step.execution[input.role]! } : {}), explicit,
    });
    const { model, ...values } = settings.values;
    const { model: _requestedModel, ...original } = input.input;
    spec = { ...original, ...values, ...(model != null ? { model } : {}), resolved_settings: settings };
    const feedback = (await ctx.store.list('feedback', { taskId: input.taskId })).items;
    const gates = (await ctx.store.list('gate_result', { taskId: input.taskId })).items;
    packet = JSON.stringify({ task, ...(step ? { step } : {}), artifacts, artifactContents, feedback, gates,
      ...(input.input.deterministic ? { supplied_deterministic_evidence: input.input.deterministic } : {}),
      note: 'Only the caller-supplied prompt and this frozen Context are assembled. Missing Ledger or external references must be reported in packet_gaps.' });
  }
  const runner = ctx.runners?.get(spec.backend ?? 'fake') ?? ctx.runner;
  if (ctx.runnerOverride && ctx.runnerOverride !== runner.id) throw new ExecutionError('Explicit Runner backend differs from resolved settings');
  if (runner.id !== (spec.backend ?? 'fake')) throw new ExecutionError('Runner backend mismatch');
  const key = run ? executionKey(run) : { taskId: input.taskId, runId: input.runId, executionId: randomUUID() };
  let readVersion: RunRequest['readVersion'];
  for (const ref of spec.artifact_refs ?? []) {
    const artifact = await ctx.store.get('artifact', { ref });
    if (artifact?.code) readVersion = { head: artifact.code.head_sha, branch: artifact.code.branch };
  }
  const request: RunRequest = { key, workspaceId: workspace.preparation.workspace_id, workdir: workspace.location.workdir,
    role: input.role, access: 'read', prompt: spec.prompt, context: packet, backend: runner.id,
    ...(spec.model ? { model: spec.model } : {}), ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
    ...(spec.timeout_seconds ? { timeout_seconds: spec.timeout_seconds } : {}), ...(spec.isolation ? { isolation: spec.isolation } : {}),
    ...(spec.output_retries !== undefined ? { output_retries: spec.output_retries } : {}), ...(readVersion ? { readVersion } : {}) };
  if (!run) {
    await runner.prepare(request);
    ({ run } = await submitRun(ctx, { taskId: input.taskId, ...(input.stepId ? { stepId: input.stepId } : {}), expectId: input.runId,
      role: input.role, purpose: input.role === 'reviewer' ? 'review' : 'plan', access: 'read', backend: runner.id,
      backendVersion: runner.version, ...(spec.model ? { model: spec.model } : {}), ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
      ...(spec.resolved_settings ? { resolvedSettings: spec.resolved_settings } : {}), sessionPath: 'new', performer: 'isolated_session', packet,
      execution: { id: key.executionId, workspace_id: request.workspaceId, input_sha256: roleDigest(spec), request_sha256: originalDigest }, executionInput: spec }));
  }
  await runner.submit(request);
  return getExecution({ ...ctx, runner }, input);
}
export async function collectExecution(ctx: WorkerCommandContext, input: { taskId: string; runId: string }) {
  const status = await getExecution(ctx, input);
  if (status.collected) return status;
  if (status.run.role === 'worker') return collectWorker(ctx, input);
  const runner = ctx.runners?.get(status.run.backend) ?? ctx.runner;
  const state = validatedRoleOutput(await runner.inspect(executionKey(status.run)), status.run.role);
  if (state.state === 'failed') await failRun(ctx, { ...input, reason: state.reason, failureKind: state.kind, receipt: state });
  if (state.state === 'completed') {
    const spec = await roleInput(ctx.store, status.run);
    if (status.run.role === 'planner') await recordDecision(ctx, { ...input, output: JSON.parse(state.workerOutput), outputText: state.workerOutput, receipt: state });
    else if (status.run.role === 'reviewer') await recordGate(ctx, { taskId: input.taskId, stepId: status.run.step_id!, reviewerRunId: input.runId,
      artifactRefs: spec.artifact_refs!, output: state.workerOutput, ...(spec.deterministic ? { deterministic: spec.deterministic } : {}), receipt: state });
  }
  return getExecution(ctx, input);
}
