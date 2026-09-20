// ADR-0019: durable asynchronous execution. Local paths never enter shared Run records.
import type { RunnerLocalRequest, RunnerLocalResult, QuestionSettings } from '../types/generated/index.js';

export type RunRequest = RunnerLocalRequest;
export type ExecutionKey = RunRequest['key'];
export type ExecutionState =
  | { state: 'prepared' }
  | { state: 'running' }
  | Extract<RunnerLocalResult['outcome'], { state: 'completed' }>
  | Extract<RunnerLocalResult['outcome'], { state: 'failed' }>
  | { state: 'unknown'; reason: string; action: string };

export interface Runner {
  /** Independent interactive question handoff. No managed Run, inspect, transcript or completion receipt. */
  openQuestion?(request: QuestionRequest): Promise<void>;
  readonly id: string;
  readonly version: string;
  readonly capabilities: {
    supportsResume: boolean; supportsLiveMessage: boolean; supportsStream: boolean; supportsCancel: boolean;
  };
  /** Persist a request WITHOUT starting it. Same identity with different input is an error. */
  prepare(request: RunRequest): Promise<void>;
  /** Only start a previously prepared request. Never replace an ambiguous execution. */
  submit(request: RunRequest): Promise<ExecutionState>;
  /** Nonblocking snapshot/result retrieval. Missing local evidence is unknown, never failed. */
  inspect(key: ExecutionKey): Promise<ExecutionState>;
  intakeWorkspace?(id: string, create?: boolean): Promise<string>;
  cancel?(key: ExecutionKey): Promise<ExecutionState>;
  message?(key: ExecutionKey, input: { id: string; text: string }): Promise<{ delivered: boolean; reason?: string }>;
  logs?(key: ExecutionKey, input?: { offset?: number; limit?: number }): Promise<{ text: string; offset: number; nextOffset: number; truncated: boolean }>;
}

export interface QuestionRequest {
  id: string;
  /** Local-only exclusion used to keep snapshot preparation outside the Task worktree. */
  workdir: string;
  /** Frozen snapshot assembled by commands; contains no local paths or live worktree mounts. */
  context: string;
  question: string;
  model?: NonNullable<QuestionSettings['model']>;
  reasoning?: NonNullable<QuestionSettings['reasoning']>;
}

/** Construct/cache adapters at the process composition boundary. */
export interface RunnerRegistry { get(backend: string): Runner }

export class ExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`${message} — 실행/기록이 남아 있을 수 있다. worker-status로 확인하라`, options);
    this.name = 'ExecutionError';
  }
}
