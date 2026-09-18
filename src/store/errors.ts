// Store 구현체가 던지는 오류. 구현체(파일, DB)와 무관하게 같은 의미를 가진다.

export interface SchemaIssue {
  /** 위반 위치 (JSON Pointer). 루트면 빈 문자열. */
  path: string;
  message: string;
}

export abstract class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 스키마를 위반하는 데이터. 쓰기에서는 아무것도 저장되지 않고, 읽기에서는 저장된 데이터가 손상된 것이다. */
export class SchemaViolationError extends StoreError {
  constructor(
    readonly phase: 'write' | 'read',
    /** 어떤 엔티티/이벤트인지 사람이 읽을 수 있는 식별자. 저장 위치가 아니다. */
    readonly subject: string,
    readonly issues: SchemaIssue[],
  ) {
    super(`schema violation on ${phase}: ${subject}: ${issues.map((i) => `${i.path || '/'} ${i.message}`).join('; ')}`);
  }
}

export class TaskNotFoundError extends StoreError {
  constructor(readonly taskId: string) {
    super(`task not found: ${taskId}`);
  }
}

/** Change.expectedLastSeq 가 현재 마지막 seq 와 다르다. 호출자는 상태를 다시 읽고 판단해야 한다. */
export class ConflictError extends StoreError {
  constructor(
    readonly taskId: string,
    readonly expectedLastSeq: number,
    readonly actualLastSeq: number,
  ) {
    super(`conflict on ${taskId}: expected last seq ${expectedLastSeq}, actual ${actualLastSeq}`);
  }
}

/** 제한 시간 안에 Task 에 대한 배타적 접근을 얻지 못했다. 재시도할 수 있다. */
export class StoreBusyError extends StoreError {
  constructor(readonly taskId: string | undefined) {
    super(`store busy${taskId ? `: ${taskId}` : ''}`);
  }
}

/**
 * 기록 도중 실패했고 변경이 반영되었는지 그 자리에서 판정하지 못했다.
 * 호출자는 readEvents 로 반영 여부를 확인해야 한다. Store 의 상태는 다음 접근에서 일관되게 복구된다.
 */
export class CommitOutcomeUnknownError extends StoreError {
  constructor(
    readonly taskId: string,
    /** 반영되었다면 이 변경의 첫 이벤트가 받았을 seq. */
    readonly firstSeq: number,
    options?: ErrorOptions,
  ) {
    super(`commit outcome unknown on ${taskId} (first seq ${firstSeq})`, options);
  }
}

/**
 * 저장소에 접근하지 못했다 (I/O 오류, 연결 실패 등). 원인은 cause 에 담긴다.
 * 쓰기에서 던져졌다면 아무것도 기록되지 않았다.
 */
export class StoreUnavailableError extends StoreError {}

/** Change 자체가 잘못되었다 (이벤트 없음, 다른 Task 의 엔티티 포함 등). 호출자의 버그다. */
export class InvalidChangeError extends StoreError {}
