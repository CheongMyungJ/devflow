// State Store: 모든 작업 상태의 저장소 (ADR-0001, ADR-0005).
// 이 파일에는 저장 방식(파일, DB)에 대한 지식이 없어야 한다. 설계 배경은 docs/design/store.md.

import type { Event, Task } from '../types/generated/index.js';
import type { SchemaIssue } from './errors.js';

/**
 * Store 가 다루는 엔티티. 새 엔티티는 아래 세 맵에 항목을 추가해서 지원한다.
 * Store 의 메서드 시그니처는 바뀌지 않는다.
 */
export interface EntityMap {
  task: Task;
}

/** 엔티티 하나를 가리키는 키. */
export interface EntityKeyMap {
  task: { taskId: string };
}

/** list 의 범위와 필터. */
export interface EntityScopeMap {
  task: { status?: Task['status'] };
}

export type EntityKind = keyof EntityMap;

/** 엔티티의 생성 또는 교체. 어느 Task 에 속하는지는 value 의 식별 필드로 정해진다. */
export type EntityWrite = { [K in EntityKind]: { kind: K; value: EntityMap[K] } }[EntityKind];

/** seq 와 task_id 는 Store 가 부여한다. at 은 호출자가 정한다. */
export type NewEvent = Omit<Event, 'seq' | 'task_id'>;

/**
 * 한 Task 에 대한 원자적 변경 단위. 전부 반영되거나 전혀 반영되지 않는다.
 * 이벤트 없는 상태 변경은 없다: events 는 1개 이상이어야 한다.
 */
export interface Change {
  /** 지정하면 Task 의 현재 마지막 seq 와 같을 때만 반영된다. 다르면 ConflictError. */
  expectedLastSeq?: number;
  writes?: EntityWrite[];
  events: [NewEvent, ...NewEvent[]];
}

export interface CommitContext {
  /** 이 변경 직전의 마지막 seq. 새 Task 면 0. */
  lastSeq: number;
}

/**
 * Change 를 직접 주거나, 배타적 접근을 얻은 뒤의 상태를 보고 만드는 함수를 준다.
 * 함수는 동기이고 부작용이 없어야 한다. 구현체가 재시도하며 여러 번 호출할 수 있다.
 */
export type ChangeInput = Change | ((ctx: CommitContext) => Change);

export interface CommitResult {
  /** seq 와 task_id 가 부여된, 실제로 기록된 이벤트. */
  events: Event[];
}

export interface InvalidEntity {
  kind: EntityKind;
  /** 사람이 읽을 수 있는 식별자. 저장 위치가 아니다. */
  subject: string;
  issues: SchemaIssue[];
}

export interface ListResult<T> {
  items: T[];
  /** 저장되어 있으나 스키마를 위반해 읽지 못한 것. 하나가 손상되었다고 목록 전체가 실패하지 않는다. */
  invalid: InvalidEntity[];
}

export interface ReadEventsOptions {
  /** 이 seq 보다 큰 이벤트만. */
  afterSeq?: number;
}

/**
 * 쓰기(createTask, commit)의 오류 계약:
 * CommitOutcomeUnknownError 가 아닌 모든 오류는 아무것도 기록되지 않았음을 뜻한다.
 * 저장소 접근 실패(I/O, 연결)는 StoreUnavailableError 로, 배타적 접근을 제때 얻지 못한 것은 StoreBusyError 로 나타난다.
 * 이 둘은 읽기에서도 던져질 수 있다.
 */
export interface Store {
  /**
   * 새 Task 를 만든다. ID 는 Store 가 발급하고, build 는 그 ID 로 Task 와 첫 이벤트들을 만든다.
   * build 가 돌려준 task.id 는 발급된 ID 와 같아야 한다 (다르면 InvalidChangeError).
   * Task 와 이벤트는 원자적으로 기록된다. 발급된 ID 는 실패해도 재사용되지 않을 수 있다 (유일하지만 연속은 아니다).
   * build 는 동기이고 부작용이 없어야 한다.
   *
   * @throws SchemaViolationError(phase=write), InvalidChangeError, StoreBusyError, StoreUnavailableError,
   *   CommitOutcomeUnknownError
   */
  createTask(build: (taskId: string) => { task: Task; events: [NewEvent, ...NewEvent[]] }): Promise<{ task: Task; events: Event[] }>;

  /**
   * 한 Task 에 대한 변경을 원자적으로 반영한다.
   * 같은 Task 에 대한 commit 은 직렬화되고, 이벤트의 seq 는 1부터 빈틈없이 증가한다.
   * 반영 전에 모든 writes 와 events 를 스키마로 검증한다. 하나라도 위반하면 아무것도 기록되지 않는다.
   *
   * @throws TaskNotFoundError, ConflictError, SchemaViolationError(phase=write), InvalidChangeError, StoreBusyError,
   *   StoreUnavailableError, CommitOutcomeUnknownError
   */
  commit(taskId: string, change: ChangeInput): Promise<CommitResult>;

  /**
   * 엔티티 하나를 읽는다. 없으면 undefined. commit 이 끝난 상태만 보인다 (반쯤 반영된 상태는 보이지 않는다).
   *
   * @throws SchemaViolationError(phase=read) 저장된 데이터가 스키마를 위반할 때. StoreBusyError, StoreUnavailableError
   */
  get<K extends EntityKind>(kind: K, key: EntityKeyMap[K]): Promise<EntityMap[K] | undefined>;

  /**
   * 범위 안의 엔티티를 식별자 순으로 돌려준다. 읽지 못한 항목은 오류로 던지지 않고 invalid 에 담는다.
   *
   * @throws StoreBusyError, StoreUnavailableError
   */
  list<K extends EntityKind>(kind: K, scope: EntityScopeMap[K]): Promise<ListResult<EntityMap[K]>>;

  /**
   * Task 의 이벤트를 seq 순으로 돌려준다. 한 commit 의 이벤트는 전부 보이거나 전혀 보이지 않는다.
   * seq 가 1부터 빈틈없이 증가하지 않으면 SchemaViolationError(phase=read).
   *
   * @throws TaskNotFoundError, SchemaViolationError(phase=read), StoreBusyError, StoreUnavailableError
   */
  readEvents(taskId: string, options?: ReadEventsOptions): Promise<Event[]>;
}
