import type { Step, VerificationResult } from '../types/generated/index.js';

/** A system check, not an AI session. All executions remain in the Task worktree. */
export interface VerificationRequest {
  id: string;
  workdir: string;
  head: string;
  commands: NonNullable<Step['verify']['deterministic']>;
}
export type VerificationState = { state: 'missing' | 'prepared' | 'running' | 'unknown' } | { state: 'completed'; result: VerificationResult };
export interface Verifier {
  prepare(request: VerificationRequest): Promise<void>;
  submit(id: string): Promise<VerificationState>;
  inspect(id: string): Promise<VerificationState>;
}
