# ADR-0015: Store 의 나머지 엔티티 — 불변 기록, commit 안의 blob, Task 안의 ID 발급, commit 식별자

- 상태: Accepted
- 날짜: 2026-09-19

## 상황
T-0001 의 Store 는 Task 와 이벤트만 다뤘고, Step·Decision·Feedback·GateResult·Run·Artifact 와 그 내용물은 0단계의 대화 세션이 yaml 을 손으로 썼다. T-0005 에서 이것들을 Store 로 옮기며 구조를 바꾸는 결정이 여럿 필요했다: 불변이어야 하는 기록(Artifact 버전, Gate)을 어떻게 지킬지, 내용물(blob)을 언제 쓸지, D-/F-/G-/R- 번호를 누가 발급할지, "결과를 알 수 없는 commit" 뒤에 내 쓰기가 들어갔는지를 무엇으로 가릴지(store.md 5절 F12), 그리고 승인 때 Artifact meta 의 `approved` 를 고쳐 쓰는 0단계의 관행이 불변과 부딪치는 것. 상세는 `docs/design/store.md` 3절, 호출자 규약은 `docs/design/commands.md` 3절.

## 결정
1. **불변은 kind 별 Store 의 계약이다.** Decision, GateResult, Artifact 버전, blob 은 이미 있는 key 에 쓰면 `AlreadyExistsError`(새 오류)이고 내용이 같아도 거부한다. 쓰기마다 모드를 주지 않는다. Task 안의 ID 가 다른 자리(다른 수준·다른 Step)에서 쓰였거나, 대소문자만 다른 key·이름의 기록이 있어도 같은 오류다(파일 시스템이 대소문자를 가리든 아니든). 거부는 lock 안, 디스크를 건드리기 전이고 "아무것도 기록되지 않았다" 의 계약에 든다.
2. **승인은 승인 Feedback 과 `artifact.approved` 이벤트로만 나타낸다. Artifact meta 는 완전히 불변이다**(사람의 선택, T-0005 F-001 (A)). `approved` 는 옛 기록을 읽기 위한 필드로 남는다.
3. **blob 은 commit 안에서 엔티티·이벤트와 함께 쓴다**(`Change.blobs`). T-0001 설계의 "commit 밖에서 먼저 쓰고 key 를 엔티티에 담는다" 를 바꾼다. key 는 기존 `blob:` 문법 그대로이고(소유자는 Run 이나 Gate), 호출자는 순수 함수 `blobRef` 로 commit 전에 key 를 안다. 큰 blob 을 쓰는 동안 그 Task 의 lock 을 쥐는 것을 받아들인다.
4. **Run·Feedback 의 key 는 Task 안의 ID 다**(`{ taskId, id }`). 수준(Task 수준인지 어느 Step 인지)은 값의 `step_id` 이고 `get` 은 Store 가 두 수준을 찾는다. **Task 안의 ID(Step, Decision, Feedback, GateResult, Run, Artifact 버전)는 Store 가 발급한다** — `commit` 의 함수 형태가 받는 `CommitContext` 의 `nextId`·`nextArtifactVersion` 이 lock 을 쥔 뒤의 기록 목록에서 가장 큰 번호의 다음을 준다.
5. **이벤트에 commit 식별자(`commit_id`, UUID)를 둔다.** Store 가 `commit`·`createTask` 호출마다 하나 만들어 그 commit 의 모든 이벤트에 넣고 `CommitResult`·`CommitOutcomeUnknownError` 에 담는다. 호출자는 주지 않는다. 결과를 알 수 없는 commit 은 이 식별자로 확인하고, 내용 비교와 저장된 Task 비교는 버린다. 식별자가 없는 옛 이벤트는 어떤 식별자와도 같지 않은 것으로 읽는다.

## 이유
- 1: 모드를 쓰기마다 주면 호출자가 빠뜨려 덮어쓰는 길이 남는다. kind 별 계약이면 Change 와 `commit` 의 시그니처가 그대로이고 DB 에서는 insert-only 제약으로 옮겨진다. 불변을 나중에 가변으로 푸는 것은 쓰는 쪽을 깨지 않지만 반대는 깬다. `ConflictError`(다시 읽고 재시도)·`InvalidChangeError`(버그)와 호출자가 할 일이 달라 오류를 따로 두었다 — 결과를 모른 채 다시 보낸 Gate 기록처럼 "이미 있다" 가 곧 원하던 상태일 수 있다. 대소문자는 NTFS 에서 `plan`/`Plan`, `R-001.Notes`/`R-001.notes` 가 한 파일이 되어 불변 기록이 덮어쓰였기 때문에 더했다(T-0005 G-003, F-005).
- 2: 승인 19건(설계 때) 모두에 승인 Feedback 과 이벤트가 이미 있었고 meta 의 `approved` 는 같은 사실의 세 번째 기록이었다. 새 메커니즘 없이 AC 의 "이미 있는 버전은 거부" 를 그대로 지키고, 승인의 기준 기록이 "특정 버전을 명시한 Feedback 과 이벤트" 하나가 된다(AGENTS.md 8번).
- 3: 소유자의 ID 가 commit 안에서 발급되므로 Gate 로그처럼 ID 를 알아야 쓸 수 있는 blob 을 commit 밖에서 먼저 쓸 수 없다(짐작한 ID 가 틀리면 남의 자리를 차지한다). 함께 쓰면 고아 blob 도 없는 blob 을 가리키는 엔티티도 생기지 않고, 불변 검사가 lock 안에서 엔티티와 같은 방식이 된다.
- 4: Run·Feedback 은 기록 곳곳에서 ID 만으로 가리켜진다(`Artifact.run_id`, `GateResult.reviewer_run_id`, `Feedback.target.run_id` 등). 기존 기록에서 두 수준이 번호를 나눠 쓰고 Task 안에서 겹치지 않는다. 발급과 쓰기가 같은 commit 이고 같은 Task 의 commit 은 직렬화되므로 동시 commit 에서도 겹치지 않는다.
- 5: 두 호출자가 같은 내용의 이벤트를 만들면 내용 비교로는 구별할 수 없다. 저장된 엔티티 비교는 뒤의 정당한 변경을 "성립하지 않음" 으로 잘못 판정한다. 이벤트와 엔티티 쓰기가 한 commit 으로 원자적이므로 자기 식별자의 이벤트가 있으면 쓰기도 들어갔다.

## 포기한 대안
- 쓰기마다 덮어쓰기 모드를 주는 것: 1의 이유. `ConflictError`·`InvalidChangeError`·`SchemaViolationError` 를 재사용하는 것: 호출자가 할 일이 다르다.
- 대소문자를 스키마에서 막는 것(소문자만 받는 문법): 옛 기록과 스키마를 바꿔야 한다. 이번에는 파일 구현체 안에서 거부하고 문법은 그대로 두었다.
- approved 의 `false → true` 한 방향 전이만 허용(B): 불변에 예외가 생기고 파일 구현체가 commit 안에서 기존 엔티티를 읽는 첫 경로가 된다. 승인을 별도 기록(`v<N>.approval.yaml`)으로(C): kind 가 늘고 승인 Feedback 과 겹친다.
- commit 밖의 `putBlob(taskId, content)`: 3의 ID 문제, lock 밖의 no-clobber 생성을 따로 보장해야 한다. 내용 주소(sha256) key: 기존 key 와 다른 형식이 생긴다.
- Run·Feedback 의 key 에 `stepId?` 를 넣는 것: 경로가 key 의 순수 함수가 되지만 호출자가 수준을 먼저 알아내야 하고, stepId 를 빠뜨린 `get` 이 조용히 `undefined` 를 돌려준다. DB 의 기본 키 `(task_id, id)` 와도 맞지 않는다.
- commit 식별자로 lock token 을 쓰는 것(파일 구현체의 개념이 인터페이스로 샌다, DB 에는 없다), `taskId + firstSeq`(되돌려진 commit 과 그 자리를 이어받은 commit 이 같은 값), 시각이 든 ULID·UUIDv7(Store 는 시계를 읽지 않는다), 호출자가 주는 값(겹침을 Store 가 보장할 수 없다).
