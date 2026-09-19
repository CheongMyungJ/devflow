// State Store: 모든 작업 상태의 저장소 (ADR-0001, ADR-0005).
// 이 파일에는 저장 방식(파일, DB)에 대한 지식이 없어야 한다. 설계 배경은 docs/design/store.md (나머지 엔티티·blob·ID 발급·commit 식별자는 3절).

import type { ArtifactVersion, Decision, Event, Feedback, GateResult, Run, Step, Task } from '../types/generated/index.js';
import type { SchemaIssue } from './errors.js';

/**
 * Store 가 다루는 엔티티. 새 엔티티는 아래 세 맵에 항목을 추가해서 지원한다.
 * Store 의 메서드 시그니처는 바뀌지 않는다.
 */
export interface EntityMap {
  task: Task;
  step: Step;
  decision: Decision;
  feedback: Feedback;
  gate_result: GateResult;
  run: Run;
  artifact: ArtifactVersion;
}

/** 엔티티 하나를 가리키는 키. */
export interface EntityKeyMap {
  task: { taskId: string };
  step: { taskId: string; stepId: string };
  decision: { taskId: string; id: string };
  /** 수준(어느 Step 에 속하는지)은 값의 step_id 다. get 은 Store 가 두 수준을 찾아 본다. */
  feedback: { taskId: string; id: string };
  gate_result: { taskId: string; stepId: string; id: string };
  /** 수준(어느 Step 에 속하는지)은 값의 step_id 다. get 은 Store 가 두 수준을 찾아 본다. */
  run: { taskId: string; id: string };
  /** artifact://<task>/<step>/<name>@v<N> */
  artifact: { ref: string };
}

/** list 의 범위와 필터. */
export interface EntityScopeMap {
  task: { status?: Task['status'] };
  step: { taskId: string; status?: Step['status'] };
  decision: { taskId: string };
  /** stepId: 생략 = 두 수준 모두, null = Task 수준만, 문자열 = 그 Step 만. */
  feedback: { taskId: string; stepId?: string | null; kind?: Feedback['kind'] };
  /** stepId: 생략 = Task 의 모든 Step. */
  gate_result: { taskId: string; stepId?: string };
  /** stepId: 생략 = 두 수준 모두, null = Task 수준만, 문자열 = 그 Step 만. */
  run: { taskId: string; stepId?: string | null; role?: Run['role'] };
  /** stepId: 생략 = Task 의 모든 Step. */
  artifact: { taskId: string; stepId?: string; name?: string };
}

export type EntityKind = keyof EntityMap;

/**
 * 엔티티의 생성 또는 교체. 어느 Task 에 속하는지는 value 의 식별 필드로 정해진다.
 * decision, gate_result, artifact 는 불변이다 — 이미 있는 key 에 쓰면 AlreadyExistsError (store.md 3.2).
 */
export type EntityWrite = { [K in EntityKind]: { kind: K; value: EntityMap[K] } }[EntityKind];

/** seq, task_id, commit_id 는 Store 가 부여한다. at 은 호출자가 정한다. */
export type NewEvent = Omit<Event, 'seq' | 'task_id' | 'commit_id'>;

/** 'blob:' 으로 시작하는 blob 의 참조. 엔티티의 content_key, log_key 등에 그대로 담는다. 만드는 것은 blobRef. */
export type BlobRef = `blob:${string}`;

/** blob 을 소유한 기록. key 의 모양이 여기서 정해진다(store.md 3.3). Gate 는 언제나 Step 수준이다. */
export type BlobOwner = { taskId: string; stepId?: string; runId: string } | { taskId: string; stepId: string; gateId: string };

export interface BlobWrite {
  owner: BlobOwner;
  /** <label> 또는 <label>.<ext>. 예: 'work-notes', 'output.json', 'deterministic', 'transcript.jsonl'. */
  name: string;
  content: string | Uint8Array;
}

/**
 * 한 Task 에 대한 원자적 변경 단위. 전부 반영되거나 전혀 반영되지 않는다.
 * 이벤트 없는 상태 변경은 없다: events 는 1개 이상이어야 한다.
 */
export interface Change {
  /** 지정하면 Task 의 현재 마지막 seq 와 같을 때만 반영된다. 다르면 ConflictError. */
  expectedLastSeq?: number;
  writes?: EntityWrite[];
  /** 이 commit 에 함께 기록할 blob. blob 은 불변이다 — 이미 있는 key 면 AlreadyExistsError. */
  blobs?: BlobWrite[];
  events: [NewEvent, ...NewEvent[]];
}

/** ID 를 Store 가 발급하는 kind. Artifact 버전은 nextArtifactVersion. */
export type IssuedIdKind = 'step' | 'decision' | 'feedback' | 'gate_result' | 'run';

export interface CommitContext {
  /** 이 변경 직전의 마지막 seq. 새 Task 면 0. */
  lastSeq: number;
  /**
   * 그 kind 의, Task 안에서 이미 있는 가장 큰 번호의 다음 ID ('R-008', 'step-004' 등). 같은 컨텍스트에서 부를 때마다 다음 번호.
   * 발급하고 쓰지 않은 ID 는 소비되지 않는다 — 다음 commit 이 같은 번호를 다시 줄 수 있다.
   */
  nextId(kind: IssuedIdKind): string;
  /** 그 Step 의 그 이름의 다음 Artifact 버전(1부터). 같은 컨텍스트에서 부를 때마다 다음 번호. */
  nextArtifactVersion(stepId: string, name: string): number;
}

/**
 * Change 를 직접 주거나, 배타적 접근을 얻은 뒤의 상태를 보고 만드는 함수를 준다.
 * 함수는 동기이고 부작용이 없어야 한다. 구현체가 재시도하며 여러 번 호출할 수 있다.
 */
export type ChangeInput = Change | ((ctx: CommitContext) => Change);

export interface CommitResult {
  /** seq, task_id, commit_id 가 부여된, 실제로 기록된 이벤트. */
  events: Event[];
  /** 이 commit 의 식별자. events 의 commit_id 와 같다. */
  commitId: string;
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
   * build 는 동기이고 부작용이 없어야 한다. 이벤트의 commit_id 는 Store 가 부여한다(돌려주는 events 에 있다).
   *
   * @throws SchemaViolationError(phase=write, 또는 저장된 상태가 손상되어 있으면 phase=read), InvalidChangeError,
   *   StoreBusyError, StoreUnavailableError, CommitOutcomeUnknownError
   */
  createTask(build: (taskId: string) => { task: Task; events: [NewEvent, ...NewEvent[]] }): Promise<{ task: Task; events: Event[] }>;

  /**
   * 한 Task 에 대한 변경을 원자적으로 반영한다. 엔티티 쓰기, blob, 이벤트가 함께 기록되거나 아무것도 기록되지 않는다.
   * 같은 Task 에 대한 commit 은 직렬화되고, 이벤트의 seq 는 1부터 빈틈없이 증가한다.
   * 호출마다 commit 식별자 하나를 만들어 그 commit 의 모든 이벤트의 commit_id 에 넣는다.
   * 반영 전에 모든 writes 와 events 를 스키마로 검증한다. 하나라도 위반하면 아무것도 기록되지 않는다.
   *
   * @throws TaskNotFoundError, ConflictError, SchemaViolationError(phase=write, 또는 저장된 상태가 손상되어 있으면 phase=read),
   *   InvalidChangeError, AlreadyExistsError, StoreBusyError, StoreUnavailableError, CommitOutcomeUnknownError
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

  /**
   * blob 하나를 읽는다. 없거나 key 가 문법에 맞지 않으면 undefined. commit 이 끝난 상태만 보인다.
   * 내용은 바이트다 — 해석(UTF-8, JSON 등)은 호출자가 이름으로 안다.
   *
   * @throws StoreBusyError, StoreUnavailableError
   */
  getBlob(ref: string): Promise<Uint8Array | undefined>;
}
