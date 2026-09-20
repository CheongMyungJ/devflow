import { randomUUID } from 'node:crypto';
import type { WorkerExecutionInput } from '../types/generated/index.js';
import { ExecutionError, type Runner, type RunRequest } from '../runner/types.js';
import { executionInput, executionKey, inputDigest, outputNotes, validatedOutput } from '../runner/records.js';
import { getWorkspace } from '../queries/workspace.js';
import { getWorkerExecution } from '../queries/worker.js';
import { isCanonicalId, isTaskId } from '../store/refs.js';
import { checkKeys, openTask, rejectIf, schemaIssues } from './common.js';
import { submitRun, completeRun, failRun } from './runs.js';
import type { WorkspaceCommandContext } from './workspace.js';

export interface WorkerCommandContext extends WorkspaceCommandContext { runner: Runner }
export interface SubmitWorkerInput { taskId: string; stepId: string; runId: string; input: WorkerExecutionInput }

/** Multi-stage command: local prepare → shared submit → external start. Never rollback an external action. */
export async function submitWorker(ctx: WorkerCommandContext, input: SubmitWorkerInput) {
  try {
    checkKeys(input, ['taskId', 'stepId', 'runId', 'input']);
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
    const key = run ? executionKey(run) : { taskId: input.taskId, runId: input.runId, executionId: randomUUID() };
    const request: RunRequest = { key, workspaceId: workspace.preparation.workspace_id, workdir: workspace.location.workdir,
      role: 'worker', access: 'write', prompt: input.input.prompt,
      ...(input.input.backend !== undefined ? { backend: input.input.backend } : {}),
      ...(input.input.model !== undefined ? { model: input.input.model } : {}),
      ...(input.input.artifacts.some((a) => a.source === 'workspace:code') ? {
        codeArtifact: { baseSha: workspace.preparation.base_sha, branch: workspace.preparation.task_branch },
      } : {}),
    };
    if (!run) {
      await ctx.runner.prepare(request);
      ({ run } = await submitRun(ctx, {
        taskId: input.taskId, stepId: input.stepId, expectId: input.runId, role: 'worker', purpose: 'execute', access: 'write',
        backend: ctx.runner.id, backendVersion: ctx.runner.version, sessionPath: 'new', performer: 'isolated_session',
        ...(input.input.model !== undefined ? { model: input.input.model } : {}),
        execution: { id: key.executionId, workspace_id: request.workspaceId, input_sha256: digest }, executionInput: input.input,
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
    checkKeys(input, ['taskId', 'runId']);
    const status = await getWorkerExecution(ctx, input);
    if (status.collected) return status;
    const state = validatedOutput(await ctx.runner.inspect(executionKey(status.run)));
    if (state.state === 'failed') {
      await failRun(ctx, { ...input, reason: state.reason, failureKind: state.kind });
    } else if (state.state === 'completed') {
      const spec = await executionInput(ctx.store, status.run);
      const notes = outputNotes(state.workerOutput);
      if (notes === undefined && spec.artifacts.some((a) => a.source === 'blob:work-notes')) {
        await failRun(ctx, { ...input, reason: 'Worker output lacks work_notes required by artifact mapping', failureKind: 'invalid_output' });
      } else {
        if (spec.artifacts.some((a) => a.source === 'workspace:code') && !state.code) throw new ExecutionError('terminal receipt lacks verified code artifact; manual inspection required');
        const artifacts = spec.artifacts.map((a) => a.source === 'workspace:code'
          ? { ...a, source: `code:${state.code!.base_sha}..${state.code!.head_sha}` } : a);
        await completeRun(ctx, { ...input, workerOutput: state.workerOutput, artifacts,
          ...(notes !== undefined ? { workNotes: notes } : {}), outputAttempts: 1 });
      }
    }
    return await getWorkerExecution(ctx, input);
  } catch (cause) {
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
