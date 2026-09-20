# commands / queries: Store 를 호출하는 쪽의 규약

- 코드: `src/commands/`, `src/queries/`
- Store 의 계약은 `docs/design/store.md` 1절과 `src/store/types.ts` 가 기준이다. 이 문서는 그 계약을 **쓰는 쪽**이 지킬 것을 정한다.
- commands/queries 는 사람과 외부가 시스템에 접근하는 유일한 경로다(AGENTS.md 1번). CLI, 서버, Orchestrator 는 이 함수들만 부른다.
- 이 문서의 한 commit·변경 없음 오류 규약은 **기록 command**의 것이다. Git을 실행하는 `prepareWorkspace`는 ADR-0018에 따른 다단계 예외이며 8절을 따른다. Worker 실행은 ADR-0019와 [Runner 계약](runner.md)을 따른다. `submitWorker`는 로컬 준비→공유 제출→외부 시작이 원자적이지 않으며 `ExecutionError` 뒤에도 실행/기록이 남을 수 있다. `collectWorker`는 기존 완료/실패 command로 기록하고 이미 terminal인 Run은 재사용한다.

## 1. 의존하는 것과 받는 방식

commands 는 첫 인자로 `CommandContext` 를 받는다. 전역 상태나 실제 시각을 직접 읽지 않는다.

| 필드 | 무엇 | 왜 주입하는가 |
|---|---|---|
| `store` | `Store` 인터페이스 | 파일 구현체와 DB 구현체를 바꿔 끼울 수 있어야 한다. commands/queries 는 `src/store/file/` 을 import 하지 않는다(`tests/architecture.test.ts` 가 확인한다) |
| `clock` | `{ now(): Date }` | Store 는 시계를 읽지 않는다. 이벤트의 `at` 과 `created_at` 은 호출자가 정한다. 주입해야 테스트가 결정적이다 |
| `actor` | `human:<id>` \| `system` \| `role:<역할>` | 누가 한 일인지는 호출 경로(CLI 의 사용자, Orchestrator, 역할 세션)가 안다 |
| `systemSha` | 실행 중인 devflow 의 commit SHA (선택) | 이벤트에 남겨 어떤 버전의 프롬프트·스키마로 실행되었는지 추적한다(ADR-0007) |
| `baseBranches` | `BaseBranchResolver` (선택) | Task 입력에 branch가 없을 때 원격 기본 branch 조회. 이름을 지정한 발행에는 필요 없다 |

Task queries는 `QueryContext`(`store`만)를 받는다. Workspace 준비는 이를 확장한 `WorkspaceCommandContext`(`workspace` 포함), Workspace 조회는 `store`와 `workspace`를 받는다. 읽기에는 시계와 행위자가 필요 없다.

Context 는 **조립 지점 한 곳**(CLI 의 main, 서버의 시작 코드, 0단계 운영 스크립트의 조립 모듈 `scripts/lib/assemble.mjs` — 6.5)에서 만들어 아래로 넘긴다.

## 2. Store 오류의 처리

원칙: **기록 commands/queries는 Store의 오류를 다른 오류로 바꾸지 않고 그대로 올린다.** 사용자에게 보일 문구로 만드는 것은 가장 바깥 계층(CLI, API)의 일이다. 다단계 `prepareWorkspace`는 8절의 오류로 감싸되 원래 오류를 cause로 보존한다.

| 오류 | 뜻 | command 가 할 일 | 바깥 계층이 사용자에게 알릴 것 |
|---|---|---|---|
| `SchemaViolationError` (write) | 입력이 스키마를 위반했다. 기록된 것이 없다 | 그대로 올린다 | `issues` 의 위치와 메시지. 입력을 고쳐 다시 시도하면 된다 |
| `SchemaViolationError` (read) | 저장된 데이터가 손상되었다 | 그대로 올린다. **자동으로 고치려 하지 않는다** | `subject` 와 `issues`. 사람이 데이터를 확인해야 한다 |
| `InvalidChangeError` | command 의 버그다 | 그대로 올린다 | 내부 오류 |
| `TaskNotFoundError` | 그런 Task 가 없다 | 그대로 올린다 | Task ID 를 확인하라 |
| `ConflictError` | 상태를 읽은 뒤 누군가 먼저 바꿨다 | 4절의 패턴 | (대개 사용자에게 보이지 않는다) |
| `AlreadyExistsError` | 불변인 기록(Decision, GateResult, Artifact 버전, blob)이 이미 있거나, Task 안의 ID 가 다른 자리에서 이미 쓰였거나, 대소문자만 다른 key·이름의 기록이 있다(store.md 3.2). 기록된 것이 없다 | 그대로 올린다. 다시 시도해도 같은 오류다. 결과를 모른 채 다시 보낸 쓰기라면 "이미 있다" 가 곧 원하던 상태일 수 있으므로 필요하면 `get` 으로 그 기록을 읽어 확인할 수 있다(결과를 알 수 없는 commit 의 확인 자체는 3절의 식별자로 한다) | `subject`(어떤 기록인지). 같은 ID·버전으로 다시 쓸 수 없다 — 새 ID·버전으로 써야 한다 |
| `StoreBusyError` | 다른 프로세스가 그 Task 를 쥐고 있다. 기록된 것이 없다 | 그대로 올린다. **command 가 다시 시도하지 않는다** — Store 가 이미 제한 시간만큼 기다렸다 | `detail` 을 **그대로** 보여 준다. 누가 쥐고 있는지, 무엇을 확인하고 무엇을 지우면 풀리는지가 들어 있다 |
| `StoreUnavailableError` | 저장소에 접근하지 못했다. 기록된 것이 없다 | 그대로 올린다 | `cause` 의 내용. 다시 시도해도 안전하다 |
| `CommitOutcomeUnknownError` | 기록되었는지 알 수 없다 | 3절의 확인 절차 | 확인까지 실패했을 때만: "기록되었는지 확인하지 못했다. `task status` 로 확인하라" |
| `RejectedInputError` (command 의 것, `src/commands/errors.ts`) | command 가 입력이나 지금 상태를 보고 받아들이지 않았다(6.3 — 도구가 채우는 필드, 표에 없는 전이, 문법에 맞지 않는 참조 등). Store 에 가기 전의 거부라 기록된 것이 없다 | command 가 던진다. Store 의 오류가 아니므로 이 절의 원칙(바꾸지 않고 올린다)과 부딪치지 않는다 | `reasons` 를 모두. 입력을 고치거나 알맞은 command 를 쓴다 — 같은 입력으로 다시 해도 같은 결과다 |

읽기(queries)도 `StoreBusyError` 를 받을 수 있다. 진행 중인 commit 이 있으면 읽기도 그것이 끝나기를 기다리기 때문이다(store.md 2.7). 정상적인 commit 은 밀리초 단위라 보이지 않지만, 어떤 프로세스가 Task 를 쥔 채 멈춰 있으면 `task status` 같은 읽기 명령도 이 오류로 끝난다. 안내는 쓰기와 같다.

`listTasks` 는 읽지 못한 Task 를 `unreadable` 로 함께 돌려준다. 바깥 계층은 이를 숨기지 말고 목록 아래에 보여 준다. Task 하나가 손상되었다고 전체 목록이 실패해서도, 손상된 Task 가 조용히 사라져서도 안 된다.

## 3. 결과를 알 수 없는 commit 의 확인

`CommitOutcomeUnknownError` 는 "기록 도중 실패했고 성립 여부를 그 자리에서 판정하지 못했다" 는 뜻이다(store.md 2.4). Store 의 상태는 다음 접근에서 일관되게 복구되므로, 호출자는 **다시 읽어서** 판정한다. `src/commands/outcome.ts` 의 `confirmOutcome(store, error, sentEvents)` 가 이 절차다.

판정의 기준은 **commit 식별자**다(store.md 3.5, T-0005). Store 는 `commit()`·`createTask()` 의 호출마다 식별자 하나를 만들어 그 commit 의 모든 이벤트의 `commit_id` 에 넣고, 결과를 알 수 없게 되면 그 값을 오류의 `commitId` 에 담는다. 식별자는 호출마다 새로 만들어지므로 다른 commit 의 이벤트가 같은 값을 가질 수 없다.

1. `store.readEvents(error.taskId, { afterSeq: error.firstSeq - 1 })` 로 그 자리부터의 이벤트를 읽는다. `TaskNotFoundError` 면 읽은 이벤트가 없는 것으로 본다.
2. 읽은 이벤트 가운데 `commit_id` 가 `error.commitId` 와 같은 것을 고른다.
3. **하나도 없으면 성립하지 않은 것이다** → `StoreUnavailableError`(원래 오류가 `cause`). "기록된 것이 없다" 는 계약으로 돌아온 것이므로 다시 시도해도 안전하다. 그 자리에 다른 이벤트가 있어도 — 내용이 보낸 것과 글자 하나 다르지 않아도 — 식별자가 다르면 남의 commit 이다.
4. **보낸 개수만큼 있고** 그것들이 `firstSeq` 부터 빈틈없이 이어지며 식별자를 뺀 내용이 보낸 것과 같으면 성립한 것이다 → command 는 성공을 돌려준다.
5. 식별자가 같은 이벤트가 있는데 4를 만족하지 않으면(개수가 모자라거나 남는다, 자리가 어긋난다, 내용이 다르다) Store 의 계약이 깨진 것이다(한 commit 의 이벤트는 전부 보이거나 전혀 보이지 않고 연속된 seq 를 받는다 — store.md 1절) → `SchemaViolationError(read)`. 자동으로 고치지 않는다(2절).
6. 1의 읽기조차 실패하면 여전히 알 수 없는 것이다 → 원래의 `CommitOutcomeUnknownError` 를 올린다.

- **식별자가 없는 옛 이벤트**(T-0005 이전의 기록, T-0006 전의 0단계 운영 스크립트가 쓴 이벤트 — 6절의 입구는 모두 Store 를 거치므로 식별자가 붙는다)는 어떤 식별자와도 같지 않으므로 2에서 골라지지 않는다. 옛 이벤트를 가르는 장치는 따로 없다.
- **엔티티 쓰기를 동반하는 command**: 이벤트와 엔티티 쓰기(와 blob)는 한 commit 으로 원자적으로 기록되므로(store.md 1절, 3.3), 자기 식별자의 이벤트가 있다는 것은 그 commit 의 쓰기도 들어갔다는 뜻이다. 저장된 엔티티를 보낸 것과 비교하지 않는다 — 비교하면 그 뒤에 다른 commit 이 정당하게 바꾼 엔티티를 "성립하지 않았다" 로 잘못 판정한다. T-0001 의 내용 비교가 기대던 전제("같은 내용의 이벤트는 같은 효과를 낸다")도 더는 필요 없다.
- **`createTask`**: 같은 절차다(`firstSeq` 는 1). 실패한 발행의 ID 가 다른 호출자에게 다시 발급되어 그 ID 의 seq 1 에 같은 행위자·같은 시각의 `task.created` 가 오더라도 식별자가 다르므로 성립하지 않은 것으로 판정된다. 그래서 저장된 Task 를 보낸 Task 와 비교하던 T-0001 의 확인은 없앤다. 성립했으면 보낸 Task 를 돌려준다.
- `expectedLastSeq` 와의 관계는 그대로다. 식별자는 "내 commit 이 들어갔는가" 를 가리고, `expectedLastSeq` 는 "내가 본 상태 위에 쓰는가" 를 가린다.

## 4. `expectedLastSeq` 를 쓰는 command 의 패턴

상태를 읽고 판단한 뒤 쓰는 command(승인, `advance` 등)는 읽을 때의 마지막 seq 를 `expectedLastSeq` 로 넘긴다. 그 사이 다른 이벤트가 끼어들었으면 `ConflictError` 가 된다.

`expectedLastSeq` 는 Task 전체 단위다. **무관한 이벤트**(실행 중 메시지, 다른 Step 의 피드백)가 끼어들어도 `ConflictError` 가 난다. 그래서 규약은 "실패로 끝낸다" 가 아니라 다음과 같다.

```
반복 (최대 N회):
  상태를 읽는다 (lastSeq 포함)
  이 command 가 여전히 유효한가?          ← 판단은 매번 새로 한다
    아니다 → 그에 맞는 결과로 끝낸다 (이미 처리됨 = 성공, 전제가 깨짐 = 오류)
    그렇다 → expectedLastSeq = lastSeq 로 commit
             ConflictError → 처음으로
```

- 멱등한 command(`advance`)는 "이미 처리됨" 을 성공으로 돌려준다. 같은 호출이 두 번 와도 이벤트는 한 번만 기록된다.
- 사람의 승인처럼 **특정 버전을 보고 내린 판단**은 다시 읽었을 때 그 버전이 여전히 최신인지 확인한다. 아니면 오류로 끝낸다(ADR-0004).
- 읽기와 판단을 Store 의 lock 안에서 하지 않는다. `ChangeInput` 의 함수 형태가 받는 `CommitContext` 에는 `lastSeq` 와 Task 안의 ID 발급(`nextId(kind)`, `nextArtifactVersion(stepId, name)` — store.md 3.4)만 있고 엔티티를 읽는 멤버는 없다(store.md 3.9). 함수 안에서 Store 를 다시 부르면 안 된다(동기·무부작용). 새 기록의 ID 는 이 함수 안에서 `nextId` 로 받아 쓴다 — lock 을 쥔 뒤의 상태로 세므로 동시 commit 과 겹치지 않는다.

`createTask` 는 읽고 판단하는 단계가 없어 이 패턴을 쓰지 않는다.

## 5. Store 인스턴스의 수명

**프로세스마다, 데이터 위치마다 Store 를 하나만 만든다.** 조립 지점에서 만들어 Context 로 넘기고, command 안에서 새로 만들지 않는다.

이유(파일 구현체 기준이지만 DB 구현체의 연결 풀에도 같은 규칙이 맞는다):
- 해제에 실패한 lock 을 **그 인스턴스가** 기억했다가 다음 접근 때 정리한다(store.md 2.9). 인스턴스가 둘이면 한쪽이 남긴 lock 을 다른 쪽은 "살아 있는 남의 lock" 으로 보고 제한 시간 뒤 `StoreBusyError` 가 된다. 기록이 깨지지는 않지만 불필요하게 막힌다.
- 찌꺼기 청소와 스키마 컴파일을 인스턴스(프로세스)당 한 번만 한다.

테스트는 예외다. 서로 다른 프로세스를 흉내 내려고 같은 위치에 인스턴스를 여럿 만든다.

## 6. 0단계의 기록을 쓰는 command 와 입구 (T-0006 의 설계)

> 상태: **설계**(T-0006 step-001), **구현**(T-0006 step-002 — 조립 지점과 빌드 캐시(6.5), 도구가 채우는 시각(아래 원칙), `appendEvents` 와 `append-events` 입구(6.2·6.3), 참조·gate id 의 문법 모듈(6.3). step-004 — Step 한 바퀴의 command 아홉(`submitRun`, `completeRun`, `failRun`, `recordGate`, `recordDecision`, `defineStep`, `requestRevision`, `approveStep`, `addFeedback`)과 입구, 7절의 전이표 모듈, 이벤트 ref 의 문법(6.3). step-005 — `createTask` 의 초 단위 시각·created_by·`task.created` 의 data 와 입구 `issue-task`, `completeTask` 와 입구 `complete-task`, Task 발행부터 done 까지의 흐름 테스트). 6.1 의 command 와 입구가 모두 있다. 결정은 ADR-0017, 근거(실험과 실측)는 그 Step 들의 작업 노트에 있다. 사람이 고른 것(T-0006 F-001, F-003)은 이 절에 반영되어 있다.

0단계에서 Orchestrator 가 손으로 쓰던 yaml 과 운영 스크립트(append-events, propose-step, record-gate)가 쓰던 기록을 모두 아래 command 로 쓴다. 운영 스크립트(`scripts/*.mjs`)는 인자와 파일을 읽어 command 를 부르는 **입구**일 뿐이다(AGENTS.md 1번). 원칙:

- **데이터 디렉터리의 모든 기록은 command 가 Store 의 commit 으로 쓴다.** 입구도 역할 세션도 데이터 디렉터리에 직접 쓰지 않는다(옮겨 가는 동안의 예외와 선택지는 6.4). Ledger(`ledger.md`)만 예외다 — Store 가 다루지 않고 command 도 쓰지 않는다(T-0006 의 non_goals). Ledger 를 고친 사실은 `ledger.updated` 로 `append-events` 가 남긴다.
- **도구가 채우는 것**: 모든 시각(이벤트의 `at`, 엔티티의 `created_at`·`submitted_at`·`ended_at` — 한 command 안에서는 `ctx.clock` 을 한 번 읽은 같은 값이고, **초 단위 UTC**(`2026-09-19T11:51:35Z` — 밀리초를 버린다. 옛 기록과 같은 모양, T-0006 F-001 (3)). 만드는 곳은 `src/commands/time.ts` 의 `recordedAt(clock)` 하나이고 `createTask` 를 포함한 모든 command 가 그것을 쓴다), Task 안의 ID(`nextId`·`nextArtifactVersion`), 엔티티의 `status`, 이벤트의 `system_sha`(조립 지점이 devflow repo 의 HEAD 로 채운다), `commit_id`(Store), 이벤트의 `actor`(아래). **시각은 어느 입구도 인자로 받지 않는다.** 입력에 시각이 있으면(예: append-events 의 `at`) 거부한다.
- **Step 의 status 를 바꾸는 command 는 step.yaml 의 `status` 와 `step.status_changed` 를 같은 commit 에 쓴다.** 한 commit 에 전이가 둘이면(승인의 in_review→approved→closed) step.yaml 에는 마지막 `to` 를 쓰고 `step.status_changed` 는 걸음마다 하나씩 쓴다. status 를 바꾸지 않는 command 는 `step.status_changed` 를 쓰지 않는다. Step 이 처음 생길 때(`recordDecision` 의 proposed)는 `step.status_changed` 를 쓰지 않고 step.yaml 과 `step.proposed` 를 같은 commit 에 쓴다 — 기존 기록에도 proposed 로의 `step.status_changed` 가 없고, `from` 이 없는 전이를 새로 만들지 않는다(T-0006 step-004, D-004). 그래서 어느 command 뒤에도 **"step.yaml 의 status = 그 Step 의 status 를 정한 마지막 이벤트"** — `step.status_changed` 가 있으면 그 마지막 것의 `to`, 없으면 `step.proposed` 의 proposed — 다(T-0006 AC3 의 "마지막 step.status_changed 의 to" 를 이렇게 읽는다. `tests/step-round-flow.test.ts` 와 Task 발행부터 done 까지의 `tests/task-flow.test.ts` 가 명령마다 이것을 검사한다).
- **읽고 판단한 뒤 쓴다** — 이 절의 기록 command 중 `createTask` 밖의 command는 4절의 패턴(`expectedLastSeq`로 commit, `ConflictError`면 다시 읽고 다시 판단)을 쓴다. 새 ID는 `ChangeInput`의 함수 안에서 `nextId`로 받는다. Workspace 실행 command는 8절의 규약을 따른다.
- **아무것도 쓰기 전에 거부한다** — 거부 조건(6.3, 7절)은 모두 commit 전에 검사한다. Store 가 막는 것(불변 kind 와 blob 의 덮어쓰기, ID 모양, 스키마)은 Store 의 오류가 그대로 올라온다(2절). 어느 쪽이든 "아무것도 기록되지 않았다" 이다.
- 이벤트의 `actor`: 사람이 한 일(Task 발행·done, Step 확정, 수정 요청, 승인, Feedback)은 `ctx.actor`(입구가 받은 `human:<id>` — 없으면 거부), 시스템의 일(Run 제출, status 의 자동 전이)은 `system`, 역할 세션의 결과를 받아들이는 일(Run 완료, Artifact, Gate, Decision)은 `role:<역할>`. 지금까지의 기록과 같은 규칙이다.

### 6.1 손 기록 ↔ command 대응표

기준은 `docs/stage0-manual-operation.md` 의 "Task 를 발행할 때", "한 Step 의 절차", "승인을 기록하는 순서", Run 기록(submitted/completed, packet_gaps 옮기기, 끊긴 실행), record-gate 의 동작, "기록하는 법"(이벤트), "Task 를 끝낼 때" 다. 한 기록은 한 command 만 쓴다.

| 0단계에서 손(또는 운영 스크립트)으로 쓰던 것 | command | 입구 (`npm run …`) | 한 commit 에 쓰는 것 |
|---|---|---|---|
| Task 발행: task.yaml + `task.created` | `createTask`(기존) | `issue-task` (새) | task.yaml(open), `task.created` |
| Planner Run 제출: `runs/R-NNN.yaml`(submitted), `R-NNN.packet.md`, `run.submitted` | `submitRun` | `submit-run` (새) | Run(submitted), blob `R-NNN.packet`, `run.submitted` |
| Planner Run 완료와 Decision: Run 의 completed·packet_gaps(Decision 에서 손으로 옮김), `R-NNN.output.yaml`, `decisions/D-NNN.yaml`(복사), `run.completed`, `decision.made`, propose-step 의 step.yaml(proposed)과 `step.proposed` | `recordDecision` | `propose-step` (이름 유지) | Run(completed, packet_gaps), blob `R-NNN.output.yaml`, Decision, `run.completed`, `decision.made`, (next_step 이면) step.yaml(proposed, `created_from`)과 `step.proposed` |
| 사람의 Step 확정(수정 반영): step.yaml(defined), `step.defined`(data.human_edit), `step.status_changed` proposed→defined | `defineStep` | `define-step` (새) | step.yaml(defined, 사람의 수정 반영), `step.defined`, `step.status_changed` |
| Worker Run 제출: Run(submitted), packet, `run.submitted`, defined→running | `submitRun` | `submit-run` | Run(submitted), blob `R-NNN.packet`, `run.submitted`, (defined 이면) step.yaml(running)과 `step.status_changed` |
| Worker Run 완료: Run 의 completed·packet_gaps(작업 노트에서 손으로 옮김), 작업 노트, Artifact meta, `run.completed`, `artifact.version_added`, running→checking(재작업이면 revising→checking) | `completeRun` | `complete-run` (새) | Run(completed, packet_gaps), blob `R-NNN.work-notes`(와 `R-NNN.output.json`), Artifact meta 들, `run.completed`, `artifact.version_added`×N, step.yaml(checking)과 `step.status_changed` |
| deterministic 결과 `gates/G-NNN.deterministic.md` | `recordGate` | `record-gate --deterministic <file>` | Gate 와 같은 commit(6.4) |
| Reviewer Run 제출 | `submitRun` | `submit-run` | Run(submitted), blob `R-NNN.packet`, `run.submitted` (status 는 checking 그대로) |
| Gate 기록: Reviewer 출력 검증, Run 에 packet_gaps, `gates/G-NNN.yaml`, `G-NNN.annotations.json`, 그 뒤 손으로 Run 닫기, `run.completed`, `gate.completed`, checking→in_review 또는 →revising | `recordGate` | `record-gate` (이름 유지) | Gate, Run(completed, packet_gaps), blob `R-NNN.output.json`·`G-NNN.annotations.json`·`G-NNN.deterministic`, `run.completed`, `gate.completed`, step.yaml(in_review 또는 revising)과 `step.status_changed` |
| 사람의 수정 요청: `feedback/F-NNN.yaml`(revision_request), `feedback.added`, in_review→revising | `requestRevision` | `request-revision` (새) | Feedback, `feedback.added`, step.yaml(revising)과 `step.status_changed` |
| 재작업의 Worker Run | `submitRun`, `completeRun` | `submit-run`, `complete-run` | 위와 같다. revising 에서는 제출이 status 를 바꾸지 않고 완료가 revising→checking |
| 질문·실행 중 지시·요구사항·답(`F-NNN.yaml`, `feedback.added`) | `addFeedback` | `add-feedback` (새) | Feedback, `feedback.added` (status 는 그대로) |
| 승인: 산출물마다 승인 Feedback, step.yaml closed, `feedback.added`×N, `artifact.approved`×N(data.gate), in_review→approved(data.official_gate), approved→closed | `approveStep` | `approve-step` (새) | 왼쪽 전부 |
| 끊긴 실행: Run(failed), `run.failed`, `R-NNN.failed.md`·`R-NNN.partial.diff` | `failRun` | `fail-run` (새) | Run(failed), blob `R-NNN.failed`·`R-NNN.partial.diff`, `run.failed` |
| Task done: task.yaml(done), `task.done`(data.confirmed, data.merge, data.post_merge_check) | `completeTask` | `complete-task` (새) | task.yaml(done), `task.done` |
| `ledger.updated` 와 command 가 다루지 않는 그 밖의 이벤트 | `appendEvents` | `append-events` (이름 유지) | 이벤트만 (`commit_id` 가 붙는다) |
| Ledger 본문 | — | — (편집 도구로 손으로) | — |
| 검증 | — (쓰지 않는다) | `validate-data`, `check-store-read` (이름 유지) | — |

- 모든 입구의 앞 두 인자는 `<data-dir> <task-id>` 다(`issue-task` 는 `<data-dir>` 만). 옛 입구의 `<task-dir>`(데이터 디렉터리 아래의 Task 디렉터리)는 받지 않는다 — Task 디렉터리가 데이터 디렉터리 바로 아래에 있다는 것은 파일 구현체의 지식이다(AGENTS.md 2번). 옛 모양으로 부르면 사용법 오류(exit 2)로 끝낸다.
- 사람이 한 일을 기록하는 입구(`issue-task`, `define-step`, `request-revision`, `add-feedback`, `approve-step`, `complete-task`)는 `--actor human:<id>` 가 없으면 사용법 오류(exit 2)로 끝내고, command 도 `ctx.actor` 가 `human:<id>` 가 아니면 거부한다. 시스템·역할 세션의 기록을 쓰는 입구(`submit-run`, `complete-run`, `fail-run`, `record-gate`, `propose-step`)는 `--actor` 를 받지 않는다 — 이벤트의 actor 는 command 가 정한다(아래 원칙).
- 옛 이벤트에 있던 `data.note`(사람의 말, 경위)는 입구가 `--note <text>` 로 받아 그 command 의 대표 이벤트(`run.submitted`, `run.completed`, `run.failed`, `step.defined`)의 `data.note` 에 넣는다. 사람의 말이 곧 기록인 입구(`request-revision`, `approve-step`, `add-feedback`)는 `--text <text>` 또는 `--text-file <file>` 로 받아 Feedback 의 `text` 에 넣는다. 시각이나 ID 를 note 로 대신 적지 않는다.
- 입구가 함께 쓰는 인자 해석·파일 읽기·결과 보고는 `scripts/lib/cli.mjs` 에 있다(Store 를 모르고 파일을 쓰지 않는다 — `node:fs` 의 읽기와 `yaml` 만). 모르는 옵션(예: 시각을 주려는 `--at`)은 사용법 오류다.

### 6.2 command 마다 — 입력, 도구가 채우는 것

모든 command 의 첫 인자는 `CommandContext` 다(1절). 입구가 읽는 파일(패킷, 역할 세션의 출력, deterministic 결과, 사람이 쓴 정의)은 로컬 경로로 받지만 그 경로는 어디에도 기록되지 않는다 — 입구가 읽어 내용만 command 에 넘기고, 내용은 blob 이나 엔티티로 들어간다. Step 한 바퀴의 command 는 `src/commands/common.ts` 의 `commitAfterReading`(4절의 패턴 — 마지막 seq 를 읽고, 읽고 판단한 뒤 거부는 commit 전에 던지고, `expectedLastSeq` 로 commit, `ConflictError` 면 5번까지 다시, `CommitOutcomeUnknownError` 는 3절의 확인)을 함께 쓴다. 새 ID·버전은 그 안의 `CommitContext` 로 받고, 발급될 id 가 기대와 다르면 그 함수 안에서 던진다(아무것도 쓰이지 않는다). 입력 객체에 받지 않는 이름이 있으면 거부한다 — 시각·id·status 같은 도구가 채우는 필드는 "도구가 채우는 필드다" 로.

**`createTask(ctx, input)`** — **구현됨**(`src/commands/create-task.ts`, 시그니처는 T-0001 그대로 — 선택 입력만 더했다). 입구 `issue-task <data-dir> <definition.yaml> [--slug <text>] [--backlog <text>] [--intake <text>] [--note <text>] --actor human:<id>`(앞 인자는 `<data-dir>` 만 — Task id 는 발급된다).
- 입력: 사람이 쓴 Task 정의 파일(YAML — 입구가 읽어 값으로 넘긴다). `id`·`status`·`created_at`·`created_by`·`target.task_branch` 가 **있으면 거부**한다(도구가 채운다 — `RejectedInputError`). 정의 파일에 입구 옵션의 자리(`branchSlug`, `createdData`)가 있어도 입구가 거부한다. 사람이 답할 질문이 남은 정의(`open_questions[].answered_by` 가 두 값 밖)는 Task 스키마가 쓰기 전에 거부하고(`SchemaViolationError`) 입구가 오류의 위치(`/open_questions/<i>/answered_by`)를 보인다.
- 선택 입력 `branchSlug`(입구의 `--slug`), `createdData`(`{ backlog?, intake?, note? }` — `task.created` 의 `data`, 지금까지의 기록에 있던 자리. 입구의 `--backlog`·`--intake`·`--note`). `CreateTaskInput` 에 선택 필드를 더한 것이라 시그니처는 깨지지 않는다.
- `target.base_branch`는 발행 입력에서는 선택이다. 생략하면 `baseBranches.defaultBranch(repo)`가 등록 원격 HEAD를 조회하며 실패하면 발행하지 않는다. `base_source` 생략은 remote, local이면 branch 이름이 필수다. branch 이름/출처를 새 Task에 항상 기록한다. 저장 스키마는 branch 이름을 계속 요구하고, 출처 필드 없는 옛 기록은 읽기 호환만 유지한다. 시작 SHA를 fetch해 고정하는 시점은 Workspace 최초 준비다(ADR-0018).
- 도구가 채우는 것: id(Store 발급), status open, created_at(`recordedAt` — 초 단위 UTC), **created_by = 사람의 id**(`ctx.actor` 에서 `human:` 을 뗀 것 — 옛 기록의 `created_by: CheongMyungJ` 와 같은 모양, T-0006 F-001 (3)), task_branch(`task/<id>-<slug>`), 이벤트 `task.created` 의 actor(`ctx.actor` 그대로 `human:<id>`)·at(created_at 과 같은 값)·system_sha·commit_id.
- 사람만 발행한다 — `ctx.actor` 가 `human:<id>` 가 아니면 거부. 읽고 판단할 것이 없어 4절의 패턴을 쓰지 않는다(Task id 는 Store 가 lock 없이 발급한다 — ADR-0011).
- 빈 데이터 디렉터리에서 Store 가 거부한 발행(스키마 위반)은 기록을 남기지 않지만 Store 의 내부 디렉터리 `.locks/`(빈 것)가 생길 수 있다 — 기록이 아니고 데이터 repo 의 `.gitignore` 가 가린다(T-0006 step-005 작업 노트).

**`submitRun(ctx, { taskId, stepId?, role, purpose?, access, backend, backendVersion?, model?, backendSessionId?, sessionPath, performer?, resumedFrom?, expectId?, packet?, note? })`** — **구현됨**(`src/commands/runs.ts`). 입구 `submit-run <data-dir> <task-id> --role <r> --access <a> --backend <b> --session-path <p> [--step <step-id>] [--purpose] [--backend-version] [--model] [--backend-session-id] [--performer] [--resumed-from R-NNN] [--expect-id R-NNN] [--packet <file>] [--note <text>]`.
- 도구가 채우는 것: Run id(`nextId('run')`), status submitted, submitted_at, system_sha, 이벤트(`run.submitted` 의 data: role, backend, 이어간 Run 이면 session_path·resumed_from, note).
- `expectId`: 패킷 본문에 Run id 가 들어가므로 Orchestrator 는 패킷을 쓰기 전에 id 를 알아야 한다. `--expect-id R-NNN` 을 주면 발급될 id 가 그것과 다를 때 거부한다(거부 메시지에 발급될 id 를 적는다). id 를 정하는 것은 여전히 Store 다.
- worker·reviewer 는 stepId 필수, planner 는 Task 수준(stepId 없음). **intake 는 받지 않는다** — intake Run 을 닫는 command 가 없어 submitted 로 남게 된다(T-0006 G-001 B. 기존 기록에 intake Run 은 없다). 필요해지면 닫는 길과 함께 더한다.
- `resumedFrom` 은 sessionPath 가 resumed·resume_failed_new 일 때 필수이고 그 밖에는 받지 않는다. 그 Run 이 Task 에 있어야 한다.
- status(7절의 표): worker 는 Step 이 defined 면 running 으로, running(앞 Run 이 failed 로 끝남)이나 revising 이면 그대로. reviewer 는 checking 에서만, 그대로.
- `packet` 은 Context 패킷의 원문이고 blob `R-NNN.packet`(파일로는 `R-NNN.packet.md`)으로 남는다. 입구는 `--packet` 의 파일을 읽어 내용만 넘긴다.

**`recordDecision(ctx, { taskId, runId, output, outputText, outputAttempts?, note? })`** — **구현됨**(`src/commands/plan.ts`). 입구 `propose-step <data-dir> <task-id> <planner-run-id> <output.yaml> [--output-attempts <n>] [--note <text>]`(이름 유지 — 뜻은 "Planner 의 출력을 받아들인다". 옛 모양 `<task-dir> <decision-id> <step-id>` 는 사용법 오류).
- output 은 Planner 의 출력 파일(Decision 모양)을 읽은 값, outputText 는 그 원문이고 blob `R-NNN.output.yaml` 로 그대로 남는다(YAML 해석은 입구가 한다 — commands 는 `yaml` 을 import 하지 않는다).
- 도구가 채우는 것: Decision 의 `id`(`nextId('decision')`), `task_id`, `planner_run_id`, `created_at` — Planner 가 적은 값은 도구의 값으로 바뀐다(원문은 blob 에 있다). Run 의 packet_gaps ← Decision 의 `packet_gaps`(0단계에서 손으로 옮기던 것 — Decision 에 없으면 Run 에도 두지 않는다), Run 의 completed·ended_at·output_attempts. next_step 이고 `step` 이 있으면 Step id(`nextId('step')`)와 step.yaml(Decision 의 `next_step.step` + id·task_id·status proposed·`created_from: D-NNN`)과 `step.proposed`(ref D-NNN). proposed 로의 `step.status_changed` 는 쓰지 않는다(6절 원칙).
- next_step 이면 `step` 이든 `skill` 이든 닫히지 않은 Step 이 있을 때 거부한다(6.3). `skill` 만인 next_step 은 Step 을 만들지 않고 Decision 과 `decision.made`(와 Run 완료)만 쓴다(Skill 을 Step 으로 펼치는 것은 아직 없다).
- action 이 done·ask_human·abort·rework 이면 Decision 과 `decision.made`(와 Run 완료)만 쓴다. Task·Step 의 status 는 바꾸지 않는다 — done 은 사람이 확정한 뒤 `completeTask` 가 쓴다.
- 도구가 채운 뒤의 Decision 과 제안된 Step 은 쓰기 전에 스키마로 검사해 위치와 함께 거부한다(Store 도 검사한다).

**`defineStep(ctx, { taskId, stepId, definition?, note? })`** — **구현됨**(`src/commands/plan.ts`). 입구 `define-step <data-dir> <task-id> <step-id> [--edited <step-definition.yaml>] [--note <text>] --actor human:<id>`.
- definition: 사람이 고친 Step 정의(id·task_id·status·created_from 없이 — 있으면 거부). 없으면 제안 그대로. `created_from` 은 제안의 것을 유지한다.
- 도구가 채우는 것: `data.human_edit` — definition 이 그 Step 의 `created_from` Decision 의 `next_step.step` 과 값이 다르면 true, 같으면 false(고친 것이 없어도 false 로 남긴다 — 0단계의 규칙). `created_from` 이 없는 옛 Step 은 지금 step.yaml 의 정의와 비교한다. status defined, `step.defined` 의 ref(= created_from), actor(`ctx.actor`).

**`completeRun(ctx, { taskId, runId, workerOutput, workNotes?, artifacts, outputAttempts?, note? })`** — **구현됨**(`src/commands/runs.ts`). Worker 의 Run 만. 입구 `complete-run <data-dir> <task-id> <run-id> --worker-output <json> [--work-notes <md>] --artifact <name>=<source> … [--output-attempts <n>] [--note <text>]`.
- workerOutput: Worker 의 출력 파일(worker-output JSON)의 원문. **필수**다(T-0006 F-001 3-가) — `schemas/worker-output.schema.json` 으로 검사하고, Run 의 packet_gaps 는 여기서 도구가 옮긴다(입력으로 packet_gaps 를 받지 않는다). 원문은 blob `R-NNN.output.json` 으로 남는다. workNotes 는 blob `R-NNN.work-notes`.
- artifacts: Step 의 `outputs` 에 선언된 이름마다 하나. `<source>` 는 `code:<base-sha>..<head-sha>`(code_change — repo·branch 는 Task 의 target 에서. 코드 변경 전체를 가리키므로 `paths` 가 없고, 그래서 `stored_in` 도 쓰지 않는다 — 아래), `repo:<base-sha>..<head-sha>:<path>[,<path>…]`(대상 repo 안의 문서, `stored_in: repo`), `blob:work-notes`(이 commit 의 작업 노트 blob, `stored_in: store` — 지금 받는 blob 출처는 이것 하나다).
- 도구가 채우는 것: 버전(`nextArtifactVersion`), ref, task_id, step_id, run_id, author worker, stored_in(`repo:` 는 repo, `blob:` 은 store — `code:` 에는 쓰지 않는다), content_key(= `blobRef`), 작업 노트가 있으면 모든 산출물의 work_notes_key, created_at, Run 의 completed·ended_at·output_attempts·packet_gaps, status(running·revising → checking).
- `code:` 의 Artifact 에 `stored_in` 이 없는 까닭: 지금 `schemas/artifact.schema.json` 은 `stored_in: repo` 에 `paths`(하나 이상)를 요구하는데 `code:` 는 파일이 아니라 base..head 의 변경 전체를 가리킨다. 그래서 새 기록이지만 스키마의 옛 기록 분기(`stored_in` 없이 `code` 만)로 쓴다 — 스키마 description 의 "새 기록에는 stored_in 을 항상 적는다" 와 어긋난다. 스키마를 고치는 것(코드 변경 전체를 뜻하는 `stored_in: repo` 에서 `paths` 를 선택으로 하는 등)은 T-0006 step-004 의 범위 밖이라 뒤로 남겼다(G-003 B).

**`recordGate(ctx, { taskId, stepId, gateId?, reviewerRunId, artifactRefs, output, annotations?, deterministic?, outputAttempts?, note? })`** — **구현됨**(`src/commands/gates.ts`). 입구 `record-gate <data-dir> <task-id> <step-id> <gate-id> <reviewer-run-id> <artifact-ref>[,…] --output <json> [--annotations <file>] [--deterministic <file>] [--output-attempts <n>] [--note <text>]`(이름 유지. 옛 모양 `<task-dir> <step-id> …` 는 사용법 오류). 옛 record-gate 의 검증 1~5 를 command 가 한다 — (1) Run 이 있고 reviewer 이고 이 Step 의 것이며 submitted 다, Gate 가 이미 있지 않다(아래의 id 규칙), (2) 출력이 `reviewer-output` 스키마에 맞는다, (3) class A 가 있으면 verdict 는 fail, (4) 만들어질 Gate 가 `gate-result` 스키마에 맞는다, (5) 고쳐질 Run 이 Run 스키마에 맞는다(Store). 옛 (4) 의 "YAML 로 썼다가 다시 읽어도 같은 값" 과 (5) 의 "기존 Run 파일의 글자를 그대로 두고 덧붙이기" 는 파일 포맷의 일이라 Store 에 맡겼다.
- 출력(`--output`)은 Reviewer 가 데이터 디렉터리 밖에 쓴 파일이고 blob `R-NNN.output.json` 으로 남는다(F-001 1-가). annotations(`--annotations`, JSON 또는 YAML, 하나 이상)는 Gate 의 `annotations` 에 담기고 blob `G-NNN.annotations.json` 으로도 남는다. deterministic 결과(`--deterministic`)는 Gate 와 같은 commit 에 blob `G-NNN.deterministic`(파일로는 `G-NNN.deterministic.md`)으로 쓴다(F-001 2-가).
- 도구가 채우는 것: Gate 의 created_at, Run 의 completed·ended_at·packet_gaps(출력의 `packet_gaps`)·output_attempts(선택 입력 — T-0006 G-001 B), Step 의 status(pass → in_review, fail → revising), `gate.completed` 의 data(verdict, class 별 수).
- gate id 는 입력으로 받되 **G-NNN 의 정규형이고 다음에 발급될 id 와 같아야 한다**(아니면 거부. API 에서 생략하면 도구가 발급한다 — 입구는 위치 인자로 받는다). Reviewer 의 패킷이 Gate id 를 먼저 언급하는 흐름을 위한 것이고, 번호를 건너뛰거나 이미 있는 Gate 의 id 를 다시 쓰지 못하게 한다.
- artifact_refs 는 참조마다 `parseArtifactRef` 로 나누어 이 Task·Step 의 것이고 그 버전의 Artifact 가 있으며 그 이름의 가장 새 버전인지 본다. 같은 참조가 두 번이면 거부.
- 한 commit 이므로 옛 record-gate 의 "Run 만 고쳐진 채 죽는" 경우(stage0 문서의 record-gate 절)가 없어진다.

**`requestRevision(ctx, { taskId, stepId, artifactRef, text })`** — **구현됨**(`src/commands/review.ts`). 입구 `request-revision <data-dir> <task-id> <step-id> <artifact-ref> (--text <text> | --text-file <file>) --actor human:<id>`. 참조는 이 Step 의 것이고 있으며 그 이름의 가장 새 버전이어야 한다(사람이 본 버전). Feedback(revision_request, channel review, target.artifact_ref), `feedback.added`(data.kind), in_review → revising.

**`addFeedback(ctx, { taskId, stepId?, kind, channel, target?: { artifactRef?, location?, runId?, decisionId? }, text })`** — **구현됨**(`src/commands/review.ts`). 입구 `add-feedback <data-dir> <task-id> --kind <kind> --channel <channel> [--step <step-id>] [--artifact-ref <ref>] [--location <text>] [--run R-NNN] [--decision D-NNN] (--text | --text-file) --actor human:<id>`. kind 는 question·direction·requirement·answer 만이다(approval 은 `approveStep`, revision_request 는 `requestRevision` 이 쓴다 — 한 기록은 한 command). target 의 artifact 참조는 문법, 이 Task(stepId 가 있으면 그 Step)의 것인지, 존재, 그 이름의 가장 새 버전인지 본다(T-0006 step-004 의 완료 조건 AC4 — 옛 버전을 가리키면 아무것도 쓰지 않고 거부한다). target 의 Run·Decision 은 그 Task 에 있어야 한다. `feedback.added` 의 data 는 kind, channel. status 는 그대로.
- `requestRevision`·`addFeedback`·`approveStep` 이 도구로 채우는 것: Feedback id(`nextId('feedback')`), author(`ctx.actor` 의 id — `human:` 을 뺀 것), created_at.

**`approveStep(ctx, { taskId, stepId, gateId, text })`** — **구현됨**(`src/commands/review.ts`). 입구 `approve-step <data-dir> <task-id> <step-id> --gate G-NNN (--text <text> | --text-file <file>) --actor human:<id>`.
- **`--gate` 는 필수다**(T-0006 F-001 (2)). 그 Gate 가 이 Step 의 것이고 pass 이며, 그 artifact_refs 가 Step 의 `outputs` 이름마다 정확히 하나씩이고(outputs 밖의 이름이 없고), 각각이 **지금도** 그 이름의 가장 새 버전일 때만 그 버전들 — 사람이 본 버전 — 을 승인한다. 사람이 Gate 를 본 뒤에 새 버전이 생겼으면(늦게 도착하거나 다시 실행된 승인, 세션 교체, 동시 실행) 아무것도 쓰지 않고 거부한다(AGENTS.md 8번, 4절).
- 도구가 채우는 것: 산출물마다 Feedback(approval, review, target.artifact_ref, text, author, created_at, id), status closed, 이벤트(6.1 의 표 — `feedback.added`×N, `artifact.approved`×N 의 data.gate, in_review → approved 의 data.official_gate = 그 Gate, approved → closed).
- Artifact meta 는 고치지 않는다(ADR-0015).

**`failRun(ctx, { taskId, runId, reason, note?, failedNotes?, partialDiff? })`** — **구현됨**(`src/commands/runs.ts`). 입구 `fail-run <data-dir> <task-id> <run-id> --reason <text> [--failed-notes <md>] [--partial-diff <file>] [--note <text>]`. Run failed(ended_at = 기록한 시각), blob `R-NNN.failed`·`R-NNN.partial.diff`, `run.failed`(data.reason, data.note). `at` 은 기록한 시각이다(실제로 끊긴 시각은 알 수 없다 — 0단계의 규칙). 어느 role 의 Run 이든 submitted 일 때만. Step 의 status 는 바꾸지 않는다.

**`completeTask(ctx, { taskId, decisionId, merge: { sha, method? }, postMergeCheck, note? })`** — **구현됨**(`src/commands/complete-task.ts`, T-0006 step-005). 입구 `complete-task <data-dir> <task-id> --decision D-NNN --merge-sha <sha> [--merge-method <text>] --post-merge-check <text> [--note <text>] --actor human:<id>`.
- 한 commit(4절의 패턴): task.yaml(status done) + `task.done`(ref = decisionId, data.confirmed = decisionId, data.merge `{ repo, branch, sha, method }`, data.post_merge_check, data.note — 옛 기록 T-0002~T-0005 의 `task.done` 과 같은 모양). merge 의 repo·branch 는 도구가 Task 의 `target.repo`·`target.base_branch` 에서 채운다(입력으로 받지 않는다). method·note 가 없으면 data 에 두지 않는다. 이 이벤트의 system_sha 는 도구가 채우는 devflow 의 HEAD 다 — merge 뒤의 main 에서 부르면 그것이 merge 뒤의 SHA 다(0단계의 규칙과 같다). actor 는 `ctx.actor`(`human:<id>`).

**`appendEvents(ctx, { taskId, events })`** — **구현됨**(`src/commands/append-events.ts`, T-0006 step-002). 입구 `append-events <data-dir> <task-id> <events.json> [--actor human:<id>]`(이름 유지). 받는 이벤트는 `{ type, step_id?, run_id?, ref?, data? }` 의 배열(하나 이상)이고 모두 한 commit 이다. 도구가 채우는 것: actor(`ctx.actor` — 입구는 `--actor human:<id>` 가 있으면 그것, 없으면 system), at(`recordedAt` — 모든 이벤트가 같은 값), system_sha(조립 지점이 채운 devflow 의 HEAD), seq·task_id·commit_id(Store). 받는 type·ref 와 거부는 6.3(ref 의 검사는 T-0006 step-004 에서 더했다 — F-003).
- 4절의 패턴이다: 마지막 seq 를 읽고, Task 의 status 와 `step_id`·`run_id` 가 그 Task 에 있는지 본 뒤 `expectedLastSeq` 로 commit 한다. `ConflictError` 면 다시 읽고 다시 판단한다(5번까지, 그 뒤에는 `ConflictError` 를 올린다). `CommitOutcomeUnknownError` 는 3절의 `confirmOutcome` 으로 확인한다.
- ledger.md 는 쓰지 않는다. Ledger 는 편집 도구로 고치고 그 사실을 `ledger.updated` 로 남긴다.

### 6.3 아무것도 쓰기 전에 거부하는 것

공통(모든 command):
- 입력에 도구가 채우는 필드가 있다 — 시각(`at`, `created_at` 등), `seq`·`task_id`·`commit_id`·`system_sha`, 엔티티의 `id`·`status`. (Planner 의 Decision 은 예외 — `recordDecision` 이 바꿔 쓴다.)
- Task 가 없다(`TaskNotFoundError`), 또는 Task 가 open 이 아니다(done·aborted 뒤에는 `appendEvents` 의 `ledger.updated` 말고는 쓰지 않는다).
- 7절의 전이표에 없는 status 전이. command 는 현재 status 를 읽고(4절) 표에 있는 전이만 한다. Store 는 가변 기록의 교체를 막지 않으므로(Run·Feedback·Step 을 같은 key 로 쓰면 오류 없이 바뀐다 — step-001 의 실험) 이 검사는 command 의 몫이다.
- 스키마 위반(Store 의 `SchemaViolationError(write)`).
- **이벤트의 ref 는 정해진 모양만 받는다**(T-0006 F-003) — `artifact://<task>/<step>/<name>@v<N>`(`parseArtifactRef`), Store 가 발급하는 ID 의 정규형 `step-NNN`·`D-NNN`·`F-NNN`·`G-NNN`·`R-NNN`(`isCanonicalId`), Task id `T-NNNN`(`isTaskId`). 판단은 `src/store/refs.ts` 의 `isEventRef` 하나다. 드라이브 문자·역슬래시·슬래시가 든 경로, 비정규 id(`G1`, `R-12`, `step-1`), 빈 문자열, 앞뒤 공백은 맞지 않는다. `appendEvents` 는 입력 이벤트의 ref 를 이것으로 거부하고, 다른 command 는 자기가 채운 ref 를 commit 직전에 같은 함수로 검사한다(맞지 않으면 command 의 버그라 `InvalidChangeError`). 기존 기록의 ref 는 모두 앞의 네 모양(artifact 참조, D·F·G)이다. 모양만 본다 — 이벤트의 `data` 칸과 event 스키마의 ref pattern 은 이 Task 의 범위 밖이다(F-003).
- command 가 스스로 거부하는 것(위의 입력 검사, 아래 표와 command 별 조건)은 `RejectedInputError`(`src/commands/errors.ts`, `reasons` 에 입력의 위치를 붙인 까닭을 모두 모은다)다. Store 의 오류는 2절대로 바꾸지 않고 올린다(없는 Task 는 `TaskNotFoundError`). 입구는 `RejectedInputError` 와 Store 의 오류를 exit 1, 인자의 모양이 틀린 것(옛 `<task-dir>` 모양 포함)을 exit 2 로 끝낸다 — 어느 쪽도 아무것도 쓰지 않았다.

T-0006 AC4 의 넷:

| 거부 | 어디서 | 방법 |
|---|---|---|
| G-NNN 모양이 아닌 gate id (`G1`, `g-009`, `G-0012`, 파일 이름이 될 수 없는 것) | `recordGate`(와 `approveStep` 의 `--gate`) | command 가 쓰기 전에 정규형 G-NNN(0 채움 3자리, 999 뒤로는 자릿수가 는다)인지 본다(입구는 인자를 그대로 넘기고 거부를 exit 1 로 보인다) — 문법은 `src/store/refs.ts` 의 `isGateId`(Store 의 파일 구현체가 쓰는 `isCanonicalId` 와 같은 함수, T-0006 step-002 에서 파일 구현체 밖으로 올렸다). Store 도 쓸 때 `InvalidChangeError` 로 막는다(실험: `id G1 is not of the form G-NNN`) — command 의 검사는 오류 문구를 사람에게 맞추고 Run 을 고치기 전에 멈추려는 것이다. 다음에 발급될 id 와 다르면 거부(6.2) |
| `artifact://<task>/<step>/<name>@v<N>` 가 아닌 artifact 참조(로컬 경로 포함) | `recordGate`, `requestRevision`, `approveStep`, `addFeedback`(target) | 참조마다 `src/store/refs.ts` 의 `parseArtifactRef`(Store 의 파일 구현체가 쓰는 것과 같은 함수 — 사본이 없다. 드라이브 문자, 역슬래시, 빈 조각, `..` 는 어느 조각에도 들어갈 수 없다)로 나누고, task·step 이 그 command 의 Task·Step 과 같고, 그 버전의 Artifact 가 있는지 `get('artifact')` 로 본다. **Store 는 GateResult 의 `artifact_refs` 와 Feedback 의 `target.artifact_ref` 의 모양을 보지 않는다** — 실험에서 `C:\x` 가 섞인 artifact_refs 의 Gate 가 기록되었다. Gate·수정 요청·승인·`addFeedback` 의 target 은 모두 그 이름의 가장 새 버전만 받는다(승인은 `--gate` 의 artifact_refs 를 이렇게 본다) |
| 이미 있는 Gate·Artifact 버전·Run·Feedback 의 덮어쓰기 | Store 와 command | Gate·Artifact 버전·Decision·blob 은 Store 가 불변으로 막는다(`AlreadyExistsError` — 실험에서 내용이 같아도 거부). Run·Feedback 은 Store 에서 가변이므로 **command 가 새 id 를 `nextId` 로만 만들고**(같은 id 를 두 번 만들 길이 없다), 기존 Run 을 고치는 command(`completeRun`, `recordGate`, `recordDecision`, `failRun`)는 그 Run 이 `submitted` 이고 role·step 이 맞을 때만 쓴다 — completed·failed 인 Run 에 다시 쓰면 거부. Feedback 을 고치는 command 는 없다(`response` 처럼 나중에 채우는 필드는 이 Task 의 범위가 아니다). 다른 자리의 같은 id 는 Store 가 막는다 |
| 허용되지 않는 status 전이 | status 를 바꾸는 모든 command | 7절의 표. 같은 Step 의 status 를 두 command 가 동시에 바꾸려 하면 `expectedLastSeq` 가 늦은 쪽을 `ConflictError` 로 돌려보내고, 다시 읽은 status 로 다시 판단한다(4절) |

command 별로 더 거부하는 것(모두 구현되었고 테스트가 조건마다 있다 — `tests/commands/runs-gates.test.ts`, `tests/commands/plan-review.test.ts`, `tests/commands/create-task.test.ts`, `tests/commands/complete-task.test.ts`, 입구는 `tests/record-gate.test.ts`, `tests/run-entries.test.ts`, `tests/plan-entries.test.ts`, `tests/task-entries.test.ts`):
- `createTask`: actor 가 사람이 아니다. 입력에 `id`·`status`·`created_at`·`created_by`·`target.task_branch` 가 있다. `createdData` 에 backlog·intake·note 밖의 필드가 있다. Task 스키마에 맞지 않다(사람이 답할 질문이 남은 `open_questions` 포함 — Store 의 `SchemaViolationError`).
- `submitRun`: role 이 intake 다. worker·reviewer 인데 stepId 가 없다, planner 인데 stepId 가 있다, 없는 Step. `expectId` 가 R-NNN 의 정규형이 아니거나 발급될 id 와 다르다. 같은 Step(planner 는 Task 수준)에 아직 `submitted` 인 같은 role 의 Run 이 있다(먼저 `failRun` 이나 완료). resumedFrom 이 sessionPath 와 맞지 않거나 없는 Run 이다. role 과 Step 의 status 가 맞지 않다(7절).
- `recordDecision`: Run 이 없거나 planner 가 아니거나 submitted 가 아니다. 출력이 객체가 아니다. 도구가 채운 뒤의 Decision 이나 제안된 Step 이 스키마에 맞지 않다. next_step 인데(`step` 이든 `skill` 이든) 닫히지 않은(closed·cancelled 가 아닌) Step 이 있다 — 0단계는 Step 을 하나씩 돈다.
- `defineStep`: actor 가 사람이 아니다. 없는 Step. Step 이 proposed 가 아니다(7절). 고친 정의에 id·task_id·status·created_from 이 있거나 Step 스키마에 맞지 않다.
- `completeRun`: Run 이 없거나 worker 가 아니거나 submitted 가 아니다. worker-output 이 JSON 이 아니거나 스키마에 맞지 않다(packet_gaps 가 없는 것 포함). `--artifact` 의 이름이 Step 의 outputs 에 없거나, 선언된 이름이 빠졌거나, 두 번 있다. 출처가 세 모양이 아니다(로컬 경로 포함), SHA 가 40자(또는 64자) 16진 소문자가 아니다, `code:` 를 code_change 가 아닌 것에, `blob:` 을 code_change 에 또는 이 commit 에 없는 blob(작업 노트 없이 `blob:work-notes`)에. output_attempts 가 1 이상의 정수가 아니다. Step 이 running·revising 이 아니다(7절).
- `failRun`: Run 이 없거나 submitted 가 아니다(이미 completed·failed). reason 이 비었다.
- `recordGate`: gate id 가 G-NNN 의 정규형이 아니거나 발급될 id 와 다르다. Run 이 없거나 reviewer 가 아니거나 다른 Step 의 것이거나 submitted 가 아니다. Reviewer 출력의 검증 1~5(6.2). artifact 참조가 없다·같은 것이 두 번·문법·Task/Step·존재·가장 새 버전. annotations 가 빈 배열이거나 배열이 아니다. Step 이 checking 이 아니다(7절).
- `requestRevision`: actor 가 사람이 아니다. text 가 비었다. 참조가 문법·Step·존재·가장 새 버전에 맞지 않다. Step 이 in_review 가 아니다(7절).
- `approveStep`: actor 가 사람이 아니다. text 가 비었다. `--gate` 가 없거나 정규형이 아니거나 그 Step 에 없다. 그 Gate 가 pass 가 아니다. 그 Gate 의 artifact_refs 가 outputs 이름마다 정확히 하나가 아니다(빠진 이름, 두 번, outputs 밖의 이름). 그 버전이 지금 그 이름의 가장 새 버전이 아니다(F-001 (2)). Step 이 in_review 가 아니다(7절 — approved 는 한 commit 안에서만 지나간다).
- `addFeedback`: actor 가 사람이 아니다. text 가 비었다. kind 가 question·direction·requirement·answer 밖이다(approval·revision_request 는 다른 command). 없는 Step. target 의 artifact 참조가 문법·Task(와 Step)·존재·가장 새 버전에 맞지 않다, target 의 Run·Decision 이 그 Task 에 없다, target 에 모르는 필드가 있다.
- `completeTask`: actor 가 사람이 아니다. Task 가 open 이 아니다(이미 done 이면 두 번째 부름도 거부). decisionId 가 D-NNN 의 정규형이 아니거나 그 Decision 이 없거나 action done 이 아니다. 닫히지 않은(closed·cancelled 가 아닌) Step 이 있다. merge sha 가 줄이지 않은 40자(또는 64자) 16진 소문자가 아니다. post_merge_check 가 비었다, merge.method 가 주어졌는데 비었다. 도구가 채우는 필드(`at`, `status` 등)나 모르는 필드(merge 의 `repo`·`branch` 포함 — 도구가 채운다)가 있다.
- `appendEvents`(구현됨): type 이 허용 목록 밖이다. 받는 것은 **짝이 되는 엔티티가 없어 다른 command 가 쓰지 않는 이벤트** 넷뿐이다 — `ledger.updated`, `run.message_sent`, `decision.answered`, `task.requirement_added`(`APPENDABLE_EVENT_TYPES`). 근거: event 스키마의 타입 스무 가지 가운데 나머지 열여섯은 짝이 되는 기록이나 status 와 한 commit 으로 쓰는 command 가 6.1 에 있거나(`task.created`·`task.done`, `decision.made`, `step.proposed`·`step.defined`·`step.status_changed`, `run.submitted`·`run.completed`·`run.failed`, `artifact.version_added`·`artifact.approved`, `feedback.added`, `gate.completed`), 엔티티의 status 를 바꾸는 이벤트라 그 status 와 함께 써야 한다(`task.aborted`, `step.cancelled`, `run.cancelled` — 아직 command 가 없다. 필요해지면 command 로 더한다). 넷은 기록할 엔티티가 없다(실행 중 지시·요구사항·답의 내용은 `addFeedback` 의 Feedback 이고, 이 이벤트는 그 사실만 남긴다). 기존 기록(데이터 repo 3f8ef30 의 T-0001~T-0006 — 이벤트 478줄, 타입 열네 가지)에서 이 넷 가운데 쓰인 것은 `ledger.updated`(66줄)뿐이다. `step.status_changed`·`run.*`·`gate.completed`·`task.done` 을 여기로 넣을 수 있으면 "step.yaml 의 status 와 마지막 step.status_changed 가 같다" 가 깨진다. 그 밖에: 입력이 빈 배열이거나 배열이 아니다, ref 가 위 공통의 "이벤트의 ref" 모양이 아니다, 도구가 채우는 필드(`at`, `seq`, `task_id`, `commit_id`, `system_sha`, `actor`)나 모르는 필드가 있다, `step_id`·`run_id` 가 그 Task 에 없다, Task 가 open 이 아닌데 `ledger.updated` 가 아닌 것이 있다. 하나라도 걸리면 전부 거부한다.

### 6.4 역할 세션의 출력과 deterministic 결과 — 데이터 디렉터리 밖에서 받아들인다

step-001 의 실험: Store 는 이미 있는 blob 의 key 에 쓰는 commit 을 거부한다. 지금 역할 세션은 자기 출력(Worker 의 `R-NNN.work-notes.md`, Reviewer 의 `R-NNN.output.json`, Planner 의 `R-NNN.output.yaml`)을 데이터 디렉터리의 최종 자리에 직접 쓰고, Orchestrator 는 deterministic 결과를 Gate 보다 먼저 `gates/G-NNN.deterministic.md` 에 둔다. 이 파일들은 Store 의 commit 없이 생긴 blob 이다.

설계(사람이 고를 것 1·2 의 권고안):
- **역할 세션은 출력을 데이터 디렉터리 밖(Orchestrator 가 패킷에 적는 임시 위치)에 쓰고, 그 기록을 받아들이는 command 가 blob 으로 쓴다**(`completeRun` 의 작업 노트, `recordGate` 의 Reviewer 출력, `recordDecision` 의 Planner 출력). 파일 이름과 자리는 지금과 같다(`R-NNN.work-notes.md` 등) — Store 가 key 로 정한다.
- 옮겨 가는 동안을 위한 길 — 그 key 의 blob 이 **이미 있고 내용이 입력과 바이트까지 같으면** 쓰지 않고 가리킨다 — 은 **만들지 않았다**(T-0006 step-004, D-004. F-001 1-가 는 이것을 받아들이기의 예외로 남겨도 된다고 했다). 그래서 역할 세션이 최종 자리에 먼저 쓴 파일이 있으면 Store 의 `AlreadyExistsError` 로 아무것도 쓰지 않고 거부된다 — 출력은 언제나 데이터 디렉터리 밖에서 받는다.
- **deterministic 결과는 `recordGate` 가 Gate 와 같은 commit 에 `G-NNN.deterministic` 으로 쓴다.** Gate 보다 먼저 쓰려면 붙일 이벤트 타입이 없고(event 스키마), 먼저 둔 파일은 `nextId('gate_result')` 를 하나 건너뛰게 한다(실험: G-001.deterministic.md 를 두자 nextId 가 G-002). Reviewer 는 패킷에 적힌 임시 위치에서 그 결과를 읽는다.
- Orchestrator 가 쓰는 패킷도 같다: `submitRun` 이 blob `R-NNN.packet` 으로 쓴다.

### 6.5 입구에서 TypeScript command 를 부르는 방법 (빌드)

운영 스크립트는 `.mjs` 이고 Node 22.15 는 TypeScript 를 그대로 import 하지 못한다(`--experimental-strip-types` 는 `src/store/file/` 의 생성자 매개변수 속성에서 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 로 멈추고, `.js` 로 적은 import 도 `.ts` 로 풀지 못한다). 정한 방법:

- **조립 지점 한 곳 — `scripts/lib/assemble.mjs` 의 `assemble({ dataDir, actor })`**(T-0006 step-002 에서 구현)이 빌드를 준비하고(`scripts/lib/build.mjs`), 빌드에서 `src/commands/index.js` 와 `src/store/file/index.js` 를 import 해 `FileStore` 를 한 번 만들고 `CommandContext`(store, `systemClock`, actor — 기본 `system`, systemSha — `git rev-parse HEAD` 로 읽은 devflow 의 HEAD, 읽지 못하면 아무것도 하지 않고 멈춘다)를 만들어 `{ commands, ctx }` 로 돌려준다. 입구는 이것을 받아 `commands.*(ctx, …)` 만 부른다. scripts/ 에서 파일 구현체를 여는 곳은 이 모듈과 검증 스크립트 `check-store-read` 뿐이고(validate-data 는 이름 규칙 모듈 `src/store/file/names.mjs` 만 import 한다), 입구는 `./lib/assemble.mjs`, 입구의 공용 모듈 `./lib/cli.mjs`(인자 해석·파일 읽기·보고 — Store 를 모르고 파일을 쓰지 않는다), `node:fs` 만 import 하고 Store 를 직접 부르지 않는다 — `tests/architecture.test.ts` 가 확인한다(AGENTS.md 1·2번).
- **빌드는 소스의 내용 해시로 확인하는 캐시다**(`scripts/lib/build.mjs` 의 `prepareBuild`). 빌드 키 = sha256(tsc 인자, `scripts/lib/` 의 `.mjs` 전부 — 로더 자신과 조립 지점, `tsconfig.json`, `package-lock.json`, `src/**/*.{ts,mts,mjs}` 의 상대 경로와 내용). 빌드는 `<cache>/<키 앞 32자>/`(기본 `<cache>` = `node_modules/.cache/devflow-entry` — git 이 무시하고, 거기서 위로 올라가며 의존성과 `schemas/` 를 찾는다)에 있고, 그 안의 `stamp.json` 의 키가 같으면 그 빌드를 쓴다. 없으면 `<cache>/.tmp-<pid>-<난수>/` 에 `node <typescript>/bin/tsc -p . --noCheck --outDir …` 로 빌드하고 `src/**/*.mjs` 를 복사하고 `stamp.json` 을 마지막에 쓴 뒤 rename 으로 제자리에 넣는다. 새 빌드를 넣은 뒤 다른 키의 옛 빌드와 한 시간 넘은 남의 임시 디렉터리를 지운다. 타입 검사는 `npm run typecheck` 의 일이고, `--noCheck` 라 생성 타입(`src/types/generated`) 없이도 빌드된다(`npm run gen` 에 기대지 않는다 — 테스트가 생성 타입을 뺀 사본으로 확인한다).
  - 옛 빌드를 쓰는 위험: 키가 소스의 내용이므로 소스(.mjs 포함)·tsconfig·lock·로더·tsc 인자 가운데 하나라도 바뀌면 다른 자리에 다시 빌드한다. 파일 시각에 기대지 않는다(checkout 이 시각을 믿을 수 없게 만든다). 스키마는 빌드에 들어가지 않고 실행 때 repo 의 `schemas/` 를 읽으므로(registry.mjs) 키에 넣지 않는다.
  - 동시에 부를 때: 제자리에는 rename 으로만 들어가므로 반쯤 된 빌드를 읽지 않는다. 둘이 같은 키로 동시에 빌드하면 늦은 쪽의 rename 이 부딪히고, 제자리의 `stamp.json` 이 같은 키면 그것을 쓰고 자기 임시 디렉터리를 지운다(`raced`). stamp 가 다르면 오류로 멈춘다. 테스트가 빈 캐시에서 두 입구를 동시에 띄워(rename 전에 기다리게 하는 테스트용 환경 변수 `DEVFLOW_BUILD_HOLD_MS`) 둘 다 빌드했고 빌드 시간이 겹쳤으며(`DEVFLOW_BUILD_TRACE` 의 시각) 하나는 `built`, 하나는 `raced` 로 같은 빌드를 써서 둘 다 기록했음을 확인한다.
  - rename의 일시적 접근 오류: 대상 디렉터리가 아직 없고 오류가 EPERM·EBUSY·EACCES이면 단조 시계 기준 최대 1초 동안 20ms 간격으로 재시도한다(T-0006 merge 뒤 Windows 검사에서 발생). 도중 같은 키의 완성본이 생기면 위 raced 경로로 사용한다. 대상이 이미 있지만 stamp가 다르거나 다른 오류이면 즉시 거부하고, 영구 접근 오류도 제한 뒤 전파한다. 외부 프로그램 중 누가 파일을 잠갔는지는 확인하지 못했다.
  - 테스트는 입구의 캐시를 쓰지 않는다: `DEVFLOW_BUILD_CACHE` 로 자기 캐시 디렉터리를 주고 끝에 지운다.
  - **키가 보지 못하는 것(한계)**: 설치된 `node_modules` 가 `package-lock.json` 과 다른 경우(`npm ci` 를 하지 않고 lock 만 바뀐 checkout 등 — lock 이 같으면 설치가 달라도 같은 키다), Node 와 tsc 의 실행 파일 자체(TypeScript 의 판은 lock 으로 본다), `src/` 밖에서 빌드에 들어가는 것(tsconfig 의 `include` 에 있는 `tests/` — 입구가 쓰지 않는다). 또 다른 키의 옛 빌드를 지우는 것은 소스가 바뀐 순간에 옛 키로 이미 돌고 있던 입구와 부딪힐 수 있다(그 입구의 import 가 실패할 수 있다 — 다시 부르면 된다. 실행해 보지 않았다).
  - 빌드물은 commit 하지 않는다(`node_modules/` 아래). 생성 타입도 만들지 않는다.
  - 구현 뒤의 실측(Windows 11, Node 22.15.1 — `append-events` 한 번, 프로세스 전체, 세 번씩): 빈 캐시에서 약 0.52 s, 캐시가 맞을 때 약 0.33 s(빈 `node -e 0` 은 약 0.12 s). check-store-read 와 `tests/global-setup.ts` 는 아직 각자 빌드한다(이 로더로 합치는 것은 backlog 의 "빌드 코드 통합").
- 실측(Windows 11, Node 22.15.1, TypeScript 7.0.2 — 한 번 부르는 프로세스 전체, 데이터 사본의 `list('step')` 한 번 포함. 세 번씩 재어 비슷했다):

  | 방법 | 한 번 부르는 시간 |
  |---|---|
  | 부를 때마다 빌드, `npx tsc -p .`(check-store-read 의 방식) | 빌드만 약 1.25 s(npx 의 기동이 약 1 s) |
  | 부를 때마다 빌드, `node …/typescript/bin/tsc -p . --noCheck` 로 직접 | 약 0.45 s |
  | 내용 해시로 확인하는 캐시 — 캐시가 맞을 때 | 약 0.27 s (해시 약 8 ms) |
  | 내용 해시로 확인하는 캐시 — 소스가 바뀐 뒤 첫 번째 | 약 0.46 s |
  | `--experimental-transform-types` + `.js`→`.ts` resolve hook(빌드 없음) | import 만 약 0.45 s |
  | 참고: 빈 `node -e 0` | 약 0.11 s |

- 버린 것: 부를 때마다 빌드(캐시보다 매번 약 0.2 s 느리고, 고정된 디렉터리를 쓰면 동시에 부른 둘이 서로의 빌드를 지운다 — 지금의 check-store-read 가 그렇다), 한 번 빌드해 두고 쓰기(`npm run build` 를 잊으면 옛 빌드를 쓴다 — 막을 장치가 결국 해시다), Node 의 transform-types(실험 기능이라 경고를 내고 우리가 만든 resolve hook 이 필요하다), tsx 같은 새 의존성(package.json 을 바꾸고 이 기계에 없다 — 재지 않았다).
- `npm run <입구>` 는 npm 자체가 약 0.6 s 를 더한다(validate-data: `node` 로 0.52 s, `npm run` 으로 1.13 s). 입구에 `pre` 스크립트(`npm run gen` 등)를 달지 않는다.

## 7. Step status 의 허용 전이표

step 스키마의 status: `proposed`, `defined`, `running`, `checking`, `in_review`, `revising`, `approved`, `closed`, `cancelled`. 표는 코드에서 `src/commands/transitions.ts` 의 `STEP_TRANSITIONS` 한 곳에 표 전체로 있고(T-0006 step-004), Step 의 status 를 바꾸거나 그대로 두는 command(`recordDecision`, `defineStep`, `submitRun`, `completeRun`, `recordGate`, `requestRevision`, `approveStep`)는 모두 그 모듈의 `nextStepStatus` 로 판단한다. 표에 없는 전이는 모든 command 가 아무것도 쓰기 전에 거부한다(`RejectedInputError`). 이 문서의 표와 코드의 표가 한 줄씩 같은지는 `tests/commands/transitions.test.ts` 가 이 문서를 읽어 대 본다. "그대로" 는 status 를 바꾸지 않고 `step.status_changed` 도 쓰지 않는 경우다.

| 지금 | 다음 | command | 뜻 |
|---|---|---|---|
| (없음) | proposed | `recordDecision` | Planner 의 next_step 을 Step 으로(`step.status_changed` 없이 `step.proposed` 가 정한다 — 6절 원칙) |
| proposed | defined | `defineStep` | 사람의 확정(수정 반영) |
| defined | running | `submitRun`(worker) | Worker 의 첫 실행 |
| running | 그대로 | `submitRun`(worker) | 앞 Worker Run 이 failed 로 끝난 뒤 다시 실행 |
| running | checking | `completeRun` | Worker 완료, 검증 대기 |
| checking | 그대로 | `submitRun`(reviewer) | Reviewer 실행(끊겨서 다시 실행해도 그대로) |
| checking | in_review | `recordGate`(pass) | 사람의 검토 대기 |
| checking | revising | `recordGate`(fail) | 사람을 거치지 않는 재작업 |
| in_review | revising | `requestRevision` | 사람의 수정 요청 |
| revising | 그대로 | `submitRun`(worker) | 재작업의 Worker 실행 |
| revising | checking | `completeRun` | 재작업 완료, 다시 검증 |
| in_review | approved | `approveStep` | 승인(같은 commit 에서 이어서 closed) |
| approved | closed | `approveStep` | Step 을 닫는다 |
| proposed·defined·running·checking·in_review·revising | cancelled | (`cancelStep` — 필요해지면 더한다) | 사람이 Step 을 버린다. 지금까지 쓰인 적이 없다 |

- closed·cancelled 는 끝이다. 거기서 나가는 전이는 없다. approved 는 `approveStep` 의 한 commit 안에서만 지나간다(0단계의 기록과 같다 — 승인과 닫기가 같은 시각이었다).
- 기존 기록(T-0001~T-0005, T-0006 의 step-001)의 `step.status_changed` 에 나오는 전이 아홉 가지 — proposed→defined, defined→running, running→checking, checking→in_review, checking→revising, in_review→revising, revising→checking, in_review→approved, approved→closed — 는 모두 이 표에 있다. 이 표는 새 command 가 할 전이의 규칙이고 옛 기록을 검사하지 않는다(T-0001 의 Step 은 proposed·defined 를 거치지 않고 running 에서 시작한다).

## 8. Workspace 실행 command와 조회 (ADR-0018)

`prepareWorkspace(ctx, { taskId })`는 **의도 기록 → Git 작업 → 완료 기록**의 다단계 command다. 기존 기록 command와 달리 호출 전체가 한 commit이 아니며 실패가 변경 없음을 뜻하지 않는다. `WorkspaceCommandContext`로 Store와 Workspace를 주입하고, CLI는 `prepare-workspace <data-dir> <task-id> [--machine-config <file>]`다.

- 최초 요청은 기준 SHA를 해석한 뒤 `workspace.prepare_requested`를 CAS로 기록한다. 이미 요청이 있으면 재사용하며 다시 fetch하지 않는다. Git 성공 뒤 `workspace.prepared`를 별도 CAS로 기록한다. 완료 기록이 이미 있으면 검사만 하고 이벤트를 추가하지 않는다.
- 요청/완료 기록은 prepareWorkspace만 쓴다. appendEvents는 받지 않는다. Task/Step status는 바꾸지 않는다. 새 기록 필드의 정의는 `schemas/workspace-preparation.schema.json`과 event 스키마가 기준이다.
- CAS 충돌은 자동 재시도하지 않는다. 결과가 불명확한 각 Store commit은 3절 규약으로 확인한다.
- `WorkspacePreparationError`는 원래 오류를 cause로 보존한다. `before_start`는 준비 의도 commit 전 실패이며 fetch의 로컬 객체/ref는 남을 수 있다. `interrupted`는 준비 기록이나 Git 결과가 남아 있을 수 있으므로 CLI가 "아무것도 기록하지 않았다"고 보고하면 안 된다. 기존 요청이 있는 재호출의 오류도 이 범주다. 내부 Workspace 오류는 configuration/conflict/busy/git/manual을 구별한다.
- `getWorkspace({ store, workspace }, taskId)`는 변경 없이 기록과 실제 작업공간을 대조한다. unprepared, pending, pending_record, ready, blocked를 반환한다. blocked의 이유와 실행 경로는 화면에만 보여 주며 공유 상태에 기록하지 않는다. 입구는 `workspace-status`다.
- 조립 지점은 `FileProjectCatalog`와 `GitWorkspace`도 생성한다. 머신 파일은 `--machine-config` 또는 `DEVFLOW_MACHINE_CONFIG`, 프로젝트 등록부는 데이터 루트의 `projects.yaml`이다. 설정 읽기는 어댑터가 하고 입구/commands는 파일 형식을 모른다.

Git 경계와 복구 처리의 상세는 `docs/design/workspace.md`, 운영 예는 `docs/stage0-manual-operation.md`를 참조한다. 잠금 자동 회수·작업공간 삭제·reset은 하지 않는다.
