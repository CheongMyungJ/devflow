export class WorkspaceError extends Error {
  constructor(readonly code: 'configuration' | 'conflict' | 'busy' | 'git' | 'manual', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

/** Git와 Store를 묶는 트랜잭션은 없다. 이 오류는 변경 없음의 보장이 아니다. */
export class WorkspacePreparationError extends Error {
  constructor(readonly phase: 'before_start' | 'interrupted', cause: unknown) {
    super(`${phase === 'before_start' ? '준비 시작 전 실패' : '준비 기록 또는 Git 작업이 남아 있을 수 있다. 같은 명령으로 다시 확인하라'}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'WorkspacePreparationError';
  }
}
