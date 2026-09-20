import { createHash } from 'node:crypto';
import { loadSchemas } from '../schema/registry.mjs';
import { blobRef } from '../store/blob-ref.js';
import type { Store } from '../store/types.js';
import type { Run, WorkerExecutionInput, WorkerOutput } from '../types/generated/index.js';
import { ExecutionError, type ExecutionKey, type ExecutionState } from './types.js';
const schemas = loadSchemas();

/** Schema has only these fields; property order in caller JSON does not affect identity. */
export function executionInputText(input: WorkerExecutionInput): string {
  return JSON.stringify({ prompt: input.prompt, artifacts: input.artifacts.map(({ name, source }) => ({ name, source })),
    ...(input.backend !== undefined ? { backend: input.backend } : {}), ...(input.model !== undefined ? { model: input.model } : {}),
    ...Object.fromEntries(['reasoning', 'timeout_seconds', 'isolation', 'output_retries', 'resolved_settings', 'context_packet'].filter(k => k in input).map(k => [k, (input as unknown as Record<string, unknown>)[k]])) });
}
export const inputDigest = (input: WorkerExecutionInput) => createHash('sha256').update(executionInputText(input)).digest('hex');
export function executionKey(run: Run): ExecutionKey {
  if (!run.execution) throw new ExecutionError('Run is record-only; no managed execution');
  return { taskId: run.task_id, runId: run.id, executionId: run.execution.id };
}
export async function executionInput(store: Store, run: Run): Promise<WorkerExecutionInput> {
  const bytes = await store.getBlob(blobRef({ taskId: run.task_id, stepId: run.step_id!, runId: run.id }, 'execution-input.json'));
  if (!bytes) throw new ExecutionError('execution input is missing');
  const value = JSON.parse(new TextDecoder().decode(bytes)) as WorkerExecutionInput;
  if (!schemas.validator('worker-execution-input')(value) || inputDigest(value) !== run.execution?.input_sha256) throw new ExecutionError('execution input integrity mismatch');
  return value;
}
export function validatedOutput(state: ExecutionState): ExecutionState {
  if (state.state !== 'completed') return state;
  try {
    if (schemas.validator('worker-output')(JSON.parse(state.workerOutput))) return state;
  } catch { /* malformed JSON is a confirmed output protocol failure */ }
  return { state: 'failed', kind: 'invalid_output', reason: 'Worker output violates worker-output schema' };
}
export function outputNotes(workerOutput: string): string | undefined {
  return (JSON.parse(workerOutput) as WorkerOutput).work_notes;
}
