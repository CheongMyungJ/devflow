# commands / queries: Store 를 호출하는 쪽의 규약

- 코드: `src/commands/`, `src/queries/`
- Store 의 계약은 `docs/design/store.md` 1절과 `src/store/types.ts` 가 기준이다. 이 문서는 그 계약을 **쓰는 쪽**이 지킬 것을 정한다.
- commands/queries 는 사람과 외부가 시스템에 접근하는 유일한 경로다(AGENTS.md 1번). CLI, 서버, Orchestrator 는 이 함수들만 부른다.

## 1. 의존하는 것과 받는 방식

commands 는 첫 인자로 `CommandContext` 를 받는다. 전역 상태나 실제 시각을 직접 읽지 않는다.

| 필드 | 무엇 | 왜 주입하는가 |
|---|---|---|
| `store` | `Store` 인터페이스 | 파일 구현체와 DB 구현체를 바꿔 끼울 수 있어야 한다. commands/queries 는 `src/store/file/` 을 import 하지 않는다(`tests/architecture.test.ts` 가 확인한다) |
| `clock` | `{ now(): Date }` | Store 는 시계를 읽지 않는다. 이벤트의 `at` 과 `created_at` 은 호출자가 정한다. 주입해야 테스트가 결정적이다 |
| `actor` | `human:<id>` \| `system` \| `role:<역할>` | 누가 한 일인지는 호출 경로(CLI 의 사용자, Orchestrator, 역할 세션)가 안다 |
| `systemSha` | 실행 중인 devflow 의 commit SHA (선택) | 이벤트에 남겨 어떤 버전의 프롬프트·스키마로 실행되었는지 추적한다(ADR-0007) |

queries 는 `QueryContext`(`store` 만)를 받는다. 읽기에는 시계와 행위자가 필요 없다.

Context 는 **조립 지점 한 곳**(CLI 의 main, 서버의 시작 코드)에서 만들어 아래로 넘긴다.

## 2. Store 오류의 처리

원칙: **commands/queries 는 Store 의 오류를 다른 오류로 바꾸지 않고 그대로 올린다.** 사용자에게 보일 문구로 만드는 것은 가장 바깥 계층(CLI, API)의 일이다. 중간에서 바꾸면 Store 가 담아 둔 안내(`StoreBusyError.detail`)나 원인(`cause`)이 사라진다.

| 오류 | 뜻 | command 가 할 일 | 바깥 계층이 사용자에게 알릴 것 |
|---|---|---|---|
| `SchemaViolationError` (write) | 입력이 스키마를 위반했다. 기록된 것이 없다 | 그대로 올린다 | `issues` 의 위치와 메시지. 입력을 고쳐 다시 시도하면 된다 |
| `SchemaViolationError` (read) | 저장된 데이터가 손상되었다 | 그대로 올린다. **자동으로 고치려 하지 않는다** | `subject` 와 `issues`. 사람이 데이터를 확인해야 한다 |
| `InvalidChangeError` | command 의 버그다 | 그대로 올린다 | 내부 오류 |
| `TaskNotFoundError` | 그런 Task 가 없다 | 그대로 올린다 | Task ID 를 확인하라 |
| `ConflictError` | 상태를 읽은 뒤 누군가 먼저 바꿨다 | 4절의 패턴 | (대개 사용자에게 보이지 않는다) |
| `StoreBusyError` | 다른 프로세스가 그 Task 를 쥐고 있다. 기록된 것이 없다 | 그대로 올린다. **command 가 다시 시도하지 않는다** — Store 가 이미 제한 시간만큼 기다렸다 | `detail` 을 **그대로** 보여 준다. 누가 쥐고 있는지, 무엇을 확인하고 무엇을 지우면 풀리는지가 들어 있다 |
| `StoreUnavailableError` | 저장소에 접근하지 못했다. 기록된 것이 없다 | 그대로 올린다 | `cause` 의 내용. 다시 시도해도 안전하다 |
| `CommitOutcomeUnknownError` | 기록되었는지 알 수 없다 | 3절의 확인 절차 | 확인까지 실패했을 때만: "기록되었는지 확인하지 못했다. `task status` 로 확인하라" |

읽기(queries)도 `StoreBusyError` 를 받을 수 있다. 진행 중인 commit 이 있으면 읽기도 그것이 끝나기를 기다리기 때문이다(store.md 2.7). 정상적인 commit 은 밀리초 단위라 보이지 않지만, 어떤 프로세스가 Task 를 쥔 채 멈춰 있으면 `task status` 같은 읽기 명령도 이 오류로 끝난다. 안내는 쓰기와 같다.

`listTasks` 는 읽지 못한 Task 를 `unreadable` 로 함께 돌려준다. 바깥 계층은 이를 숨기지 말고 목록 아래에 보여 준다. Task 하나가 손상되었다고 전체 목록이 실패해서도, 손상된 Task 가 조용히 사라져서도 안 된다.

## 3. 결과를 알 수 없는 commit 의 확인

`CommitOutcomeUnknownError` 는 "기록 도중 실패했고 성립 여부를 그 자리에서 판정하지 못했다" 는 뜻이다(store.md 2.4). Store 의 상태는 다음 접근에서 일관되게 복구되므로, 호출자는 **다시 읽어서** 판정한다. `src/commands/outcome.ts` 의 `confirmOutcome(store, error, sentEvents)` 가 이 절차다.

1. `store.readEvents(error.taskId, { afterSeq: error.firstSeq - 1 })` 로 그 자리부터의 이벤트를 읽는다.
2. 앞에서부터 보낸 개수만큼의 이벤트가 seq, task_id, **내용**까지 보낸 것과 같으면 성립한 것이다 → command 는 성공을 돌려준다.
3. Task 가 없거나 그 자리의 내용이 다르면 성립하지 않은 것이다 → `StoreUnavailableError`(원래 오류가 `cause`). "기록된 것이 없다" 는 계약으로 돌아온 것이므로 다시 시도해도 안전하다.
4. 1의 읽기조차 실패하면 여전히 알 수 없는 것이다 → 원래의 `CommitOutcomeUnknownError` 를 올린다.

**다른 호출자의 이벤트를 자기 것으로 오인하지 않는가.** 이벤트에 commit 식별자가 없어(store.md 5절 F12) 내용으로만 비교한다.
- `createTask`: Task ID 는 그 호출에만 발급된다. 그 Task 의 seq 1 자리에 쓸 수 있는 호출자는 하나뿐이므로 오인할 수 없다.
- 기존 Task 에 대한 command: 두 호출자가 **같은 자리에 같은 내용**을 보낸 경우에만 구별되지 않는다. 그 경우 Task 의 상태는 이 호출자가 원한 그대로이므로 성공으로 보아도 결과가 같다. 내용이 조금이라도 다르면(actor, at, data) 성립하지 않은 것으로 판정한다. 이 논리는 "같은 내용의 이벤트는 같은 효과를 낸다" 는 전제에 기대므로, 이벤트가 엔티티 쓰기와 함께 가는 command 는 `expectedLastSeq` 를 함께 써서 한쪽만 성립하게 한다.

commit 식별자가 생기면(F12) 2의 비교를 식별자 비교로 바꾼다.

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
- 읽기와 판단을 Store 의 lock 안에서 하지 않는다. `ChangeInput` 의 함수 형태는 `lastSeq` 만 받으며, 그 안에서 Store 를 다시 부르면 안 된다(동기·무부작용).

이번 Task 의 `createTask` 는 읽고 판단하는 단계가 없어 이 패턴을 쓰지 않는다.

## 5. Store 인스턴스의 수명

**프로세스마다, 데이터 위치마다 Store 를 하나만 만든다.** 조립 지점에서 만들어 Context 로 넘기고, command 안에서 새로 만들지 않는다.

이유(파일 구현체 기준이지만 DB 구현체의 연결 풀에도 같은 규칙이 맞는다):
- 해제에 실패한 lock 을 **그 인스턴스가** 기억했다가 다음 접근 때 정리한다(store.md 2.9). 인스턴스가 둘이면 한쪽이 남긴 lock 을 다른 쪽은 "살아 있는 남의 lock" 으로 보고 제한 시간 뒤 `StoreBusyError` 가 된다. 기록이 깨지지는 않지만 불필요하게 막힌다.
- 찌꺼기 청소와 스키마 컴파일을 인스턴스(프로세스)당 한 번만 한다.

테스트는 예외다. 서로 다른 프로세스를 흉내 내려고 같은 위치에 인스턴스를 여럿 만든다.
