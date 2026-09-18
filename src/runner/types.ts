// Runner: AI 세션을 실행하는 유일한 경로 (ADR-0005, ADR-0010).
// Orchestrator 는 이 인터페이스만 알고, 백엔드별 CLI 지식은 어댑터 안에 있다.

import type { Run } from '../types/generated/index.js';

export type Role = Run['role'];
export type Access = Run['access'];
export type RunPurpose = NonNullable<Run['purpose']>;

/** 실행 시점에만 쓰이는 경로들. 상태 기록에 저장하지 않는다. */
export interface RunLocations {
  /** 세션의 작업 디렉터리. Worker/Reviewer 는 Task 의 worktree. */
  workdir: string;
  /** 역할이 구조화된 출력(JSON)과 문서 산출물을 쓰는 디렉터리. */
  outputDir: string;
}

export interface RunRequest {
  runId: string;
  taskId: string;
  stepId?: string;
  role: Role;
  purpose: RunPurpose;
  access: Access;
  /** 역할 프롬프트 + 시스템이 조립한 Context 패킷. 도구 중립적인 텍스트. */
  prompt: string;
  locations: RunLocations;
  model?: string;
  /**
   * 이어갈 이전 실행. 어댑터가 resume 을 시도하고, 불가능하면 ResumeUnavailableError 를 던진다.
   * 그 경우 호출자는 Context 패킷으로 새 세션을 제출한다 (resume 은 최적화일 뿐이다).
   */
  resume?: { backendSessionId: string; message: string };
}

/** 백엔드 출력 스트림을 정규화한 이벤트. attach/log 표시와 transcript 저장에 쓴다. */
export type SessionEvent =
  | { type: 'session_started'; backendSessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; summary: string }
  | { type: 'tool_result'; summary: string; isError: boolean }
  | { type: 'end'; outcome: 'completed' | 'failed' | 'cancelled'; error?: string };

export interface RunResult {
  runId: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  backendSessionId?: string;
  backendVersion?: string;
  error?: string;
}

export interface AdapterCapabilities {
  /** 실행 중인 세션에 메시지를 주입할 수 있는가. 없으면 Runner 가 "중단 → resume" 으로 대체한다. */
  supportsLiveMessage: boolean;
  supportsResume: boolean;
}

/** 어댑터가 돌려주는 실행 중 세션의 핸들. */
export interface SessionHandle {
  events: AsyncIterable<SessionEvent>;
  result: Promise<RunResult>;
  /** supportsLiveMessage 가 true 인 어댑터만 구현한다. */
  sendMessage?(text: string): Promise<void>;
  cancel(): Promise<void>;
}

export interface BackendAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  version(): Promise<string>;
  start(request: RunRequest): Promise<SessionHandle>;
}

export class ResumeUnavailableError extends Error {
  constructor(
    readonly backend: string,
    reason: string,
  ) {
    super(`resume unavailable on ${backend}: ${reason}`);
    this.name = 'ResumeUnavailableError';
  }
}

/**
 * Orchestrator 가 쓰는 인터페이스. 메시지의 이벤트 기록은 commands 계층이 먼저 수행하고,
 * 그 뒤에 sendMessage 가 호출된다 (ADR-0006).
 */
export interface Runner {
  submit(request: RunRequest, backend: string): Promise<{ runId: string }>;
  result(runId: string): Promise<RunResult>;
  stream(runId: string): AsyncIterable<SessionEvent>;
  sendMessage(runId: string, text: string): Promise<void>;
  cancel(runId: string): Promise<void>;
}
