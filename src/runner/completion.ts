import type { Run, RunnerLocalResult } from '../types/generated/index.js';

/** Transport receipt fields are recorded at the same commit as the role output. */
export function completionFields(receipt?: RunnerLocalResult['outcome']): Partial<Run> {
  if (!receipt) return {};
  return {
    ...(receipt.processEndedAt ? { process_ended_at: receipt.processEndedAt } : {}),
    ...(receipt.backendSessionId ? { backend_session_id: receipt.backendSessionId } : {}),
    ...(receipt.outputAttempts ? { output_attempts: receipt.outputAttempts } : {}),
  };
}
