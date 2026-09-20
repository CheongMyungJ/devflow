import { createHash } from 'node:crypto';
import { loadSchemas } from '../schema/registry.mjs';
import { blobRef } from '../store/blob-ref.js';
import type { Store } from '../store/types.js';
import type { RoleExecutionInput, Run, ReviewerOutput } from '../types/generated/index.js';
import { ExecutionError, type ExecutionState } from './types.js';
const schemas = loadSchemas();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const roleDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export async function roleInput(store: Store, run: Run): Promise<RoleExecutionInput> {
  const bytes = await store.getBlob(blobRef({ taskId: run.task_id, ...(run.step_id ? { stepId: run.step_id } : {}), runId: run.id }, 'execution-input.json'));
  if (!bytes) throw new ExecutionError('execution input is missing');
  const input = JSON.parse(new TextDecoder().decode(bytes)) as RoleExecutionInput;
  if (!schemas.validator('role-execution-input')(input) || roleDigest(input) !== run.execution?.input_sha256) throw new ExecutionError('execution input integrity mismatch');
  return input;
}
export function validatedRoleOutput(state: ExecutionState, role: Run['role']): ExecutionState {
  if (state.state !== 'completed') return state;
  try {
    const output = JSON.parse(state.workerOutput);
    const reviewer = output as ReviewerOutput;
    if (schemas.validator(`${role}-output`)(output) && !(role === 'reviewer' && reviewer.verdict !== 'fail' && reviewer.comments.some(c => c.class === 'A'))) return state;
  } catch { /* invalid output */ }
  return { state: 'failed', kind: 'invalid_output', reason: `Role output violates ${role} output contract`, ...(state.processEndedAt ? { processEndedAt: state.processEndedAt } : {}) };
}
