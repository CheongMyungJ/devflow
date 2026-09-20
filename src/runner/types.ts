// ADR-0019: durable asynchronous execution. Local paths never enter shared Run records.
import type { RunnerLocalRequest, RunnerLocalResult } from '../types/generated/index.js';

export type RunRequest = RunnerLocalRequest;
export type ExecutionKey = RunRequest['key'];
export type ExecutionState =
  | { state: 'prepared' }
  | { state: 'running' }
  | Extract<RunnerLocalResult['outcome'], { state: 'completed' }>
  | { state: 'failed'; kind: 'process_exit' | 'invalid_output'; reason: string }
  | { state: 'unknown'; reason: string; action: string };

export interface Runner {
  readonly id: string;
  readonly version: string;
  readonly capabilities: {
    supportsResume: false; supportsLiveMessage: false; supportsStream: false; supportsCancel: false;
  };
  /** Persist a request WITHOUT starting it. Same identity with different input is an error. */
  prepare(request: RunRequest): Promise<void>;
  /** Only start a previously prepared request. Never replace an ambiguous execution. */
  submit(request: RunRequest): Promise<ExecutionState>;
  /** Nonblocking snapshot/result retrieval. Missing local evidence is unknown, never failed. */
  inspect(key: ExecutionKey): Promise<ExecutionState>;
}

export class ExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`${message} — 실행/기록이 남아 있을 수 있다. worker-status로 확인하라`, options);
    this.name = 'ExecutionError';
  }
}
