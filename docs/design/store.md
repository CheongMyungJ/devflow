# State Store 설계

- 인터페이스: `src/store/types.ts`, 오류: `src/store/errors.ts`, blob key 의 문법: `src/store/blob-ref.ts`. 파일 구현체: `src/store/file/`(파일 이름 규칙은 `layout.ts`)
- 대상: T-0001 (Task + 이벤트). 나머지 엔티티(Step, Decision, Feedback, GateResult, Run, Artifact)와 blob, Task 안의 ID 발급, 덮어쓰기 방지, commit 식별자는 T-0005 에서 설계하고 구현했다(3절). 구조를 바꾼 결정과 그 이유는 ADR-0011, ADR-0015, ADR-0016.

## 0. 핵심 결정

| 결정 | 내용 |
|---|---|
| 기준 기록 | **이벤트 로그는 "무슨 일이 어떤 순서로 있었는가" 의 기준, 엔티티 문서는 "현재 내용" 의 기준.** 완전한 event sourcing(이벤트에서 엔티티를 재구성)은 하지 않는다. 이벤트는 엔티티 전체 내용을 담지 않고 참조만 한다 |
| 변경 단위 | `commit(taskId, change)` 하나가 엔티티 쓰기 N개 + blob N개 + 이벤트 1개 이상을 **원자적으로** 반영한다. 이벤트 없는 상태 변경은 없다 |
| 직렬화 범위 | Task 단위. 서로 다른 Task 의 commit 은 서로 기다리지 않는다 |
| 동시성 제어 | Task 별 배타적 접근 + 선택적 낙관적 검사(`expectedLastSeq`) |
| ID 발급 | Store 가 발급한다. Task ID 는 `createTask(build)` 가, Task 안의 ID(Step, Decision, Feedback, GateResult, Run, Artifact 버전)는 `commit` 의 함수 형태가 받는 `CommitContext` 의 `nextId`·`nextArtifactVersion` 이 준다(3.4). 호출자는 발급된 ID 를 받아 엔티티를 만든다 |
| 불변 기록 | Decision, GateResult, Artifact, blob 은 한 번 쓰면 다시 쓸 수 없다. kind 별 Store 의 계약이고 쓰기마다 모드를 주지 않는다. 이미 있으면 `AlreadyExistsError`(3.2) |
| commit 식별자 | 호출마다 Store 가 하나 만들어 그 commit 의 모든 이벤트의 `commit_id` 에 넣는다. 결과를 알 수 없는 commit 은 이것으로 확인한다(3.5) |
| 검증 | 쓰기 전 전부 검증(하나라도 위반하면 아무것도 기록 안 함), 읽을 때마다 검증 |
| 엔티티 접근 | `get(kind, key)` / `list(kind, scope)` 의 제네릭 형태. 엔티티 추가 시 시그니처가 바뀌지 않는다. blob 은 `getBlob(ref)` |

완전한 event sourcing 을 택하지 않은 이유: 이벤트마다 엔티티 전체를 실어야 하고, 읽을 때마다 재구성(또는 스냅샷 관리)이 필요해 MVP 에 비해 과하다. 사람이 에디터로 `task.yaml` 을 바로 읽을 수 있다는 파일 구현체의 이점도 사라진다. 대신 "엔티티 쓰기와 이벤트 기록은 항상 같은 commit" 이라는 규칙으로 둘의 불일치를 막는다.

## 1. 메서드의 의미와 보장

### `createTask(build)`
- Store 가 새 Task ID(`T-NNNN`)를 발급하고 `build(taskId)` 를 호출해 Task 와 첫 이벤트(들)를 받는다. Task 와 이벤트를 하나의 commit 으로 기록한다. 첫 이벤트의 seq 는 1.
- ID 는 **유일하지만 연속은 아니다.** 기록에 실패하면 그 ID 는 버려질 수 있다.
- `build` 가 돌려준 `task.id` 가 발급된 ID 와 다르면 `InvalidChangeError`.
- commit 식별자(3.5)는 `commit` 과 같이 호출마다 하나이고, 반환 타입은 그대로라 돌려주는 `events[].commit_id` 로 보인다.
- `build` 는 동기·무부작용. (callback 인 이유: `target.task_branch` 처럼 ID 에 의존하는 필드가 있어 호출자가 ID 를 알아야 Task 를 완성할 수 있다.)
- 멱등 아님. 두 번 호출하면 Task 가 두 개 생긴다. 중복 방지는 호출자(commands)의 책임.

### `commit(taskId, change)`
- 원자성: writes, blobs, events 가 전부 반영되거나 전혀 반영되지 않는다. 프로세스가 중간에 죽어도 마찬가지다(2.5).
- 순서: 같은 Task 의 commit 은 직렬화된다. seq 는 1부터 빈틈없이 증가한다. 한 commit 의 이벤트들은 연속된 seq 를 받는다.
- `expectedLastSeq` 가 있으면 현재 마지막 seq 와 같을 때만 반영, 다르면 `ConflictError`. "v2 를 보고 누른 승인이 v3 에 적용되는 사고" 를 막는 수단이다(ADR-0004, ADR-0005). 생략하면 검사하지 않는다(마지막에 쓴 쪽이 이긴다).
- `change` 를 함수로 주면 배타적 접근을 얻은 뒤의 상태를 담은 `CommitContext` — `lastSeq`, Task 안의 다음 ID 를 주는 `nextId(kind)`, 다음 Artifact 버전을 주는 `nextArtifactVersion(stepId, name)`(3.4) — 를 보고 Change 를 만들 수 있다. 엔티티를 읽는 멤버는 없다(3.9). 함수는 동기·무부작용이고 여러 번 호출될 수 있다.
- commit 식별자: 호출마다 하나를 만들어 그 commit 의 모든 이벤트의 `commit_id` 에 넣고 `CommitResult.commitId` 로 돌려준다. 호출자는 이벤트에 `commit_id` 를 담지 않는다(`NewEvent` 에 없다. 담아 보내면 `InvalidChangeError`) (3.5).
- 검증: 모든 writes 는 해당 엔티티 스키마로, 모든 events 는 seq/task_id/commit_id 부여 후 event 스키마로 검증한다. 쓰기 때의 확인 — writes 의 엔티티나 blob 의 소유자가 다른 Task 에 속함, ID 의 모양, Artifact 의 `ref`·내용 key, 한 Change 안의 중복, blob key 의 문법 — 에 걸리면 `InvalidChangeError`(3.1, 3.3, 3.11). 불변 기록이 이미 있거나 Task 안의 ID 가 다른 자리에서 쓰였거나 대소문자만 다른 key·이름의 기록이 있으면 `AlreadyExistsError`(3.2 의 덮어쓰기 방지). 모두 디스크를 건드리기 전이다.
- 멱등 아님. 같은 Change 를 두 번 commit 하면 이벤트가 두 번 기록된다. 멱등성이 필요한 호출자(`advance`)는 `expectedLastSeq` 를 쓴다 — 두 번째 호출은 `ConflictError` 가 된다.
- 오류: `TaskNotFoundError`, `ConflictError`, `SchemaViolationError(write)`, `InvalidChangeError`, `AlreadyExistsError`(3.2, T-0005), `StoreBusyError`. **`CommitOutcomeUnknownError` 가 아닌 모든 오류는 — 여기 나열되지 않은 I/O 오류까지 포함해 — 아무것도 기록되지 않았음을 뜻한다.** 이것이 인터페이스의 계약이고 `createTask` 에도 똑같이 적용된다.
- 결과를 알 수 없는 경우: 기록 도중 I/O 오류가 났고 성립 여부를 그 자리에서 판정하지 못하면 `CommitOutcomeUnknownError` 를 던진다. 호출자는 `readEvents` 로 성립 여부를 확인해야 한다(오류에 담긴 commit 식별자로 — 3.5, `docs/design/commands.md` 3절). 어느 쪽으로든 Store 의 상태는 다음 접근에서 일관되게 복구된다. (DB 구현체에서는 COMMIT 도중 연결이 끊긴 경우에 해당한다.)
- commit 이 성립한 뒤의 뒷정리 실패는 오류가 아니다. `commit()` 은 성공을 돌려주고 뒷정리는 다음 접근이 마친다(2.4, 2.5).

### `get(kind, key)` / `list(kind, scope)`
- 끝난 commit 의 결과만 보인다. 반쯤 반영된 상태는 보이지 않는다. 파일 구현체가 이를 어떻게 보장하는지는 2.7.
- `get`: 없으면 `undefined`, 있는데 스키마 위반이거나 값이 그 자리의 것이 아니면(3.11) `SchemaViolationError(read)`. Run·Feedback 은 key 에 수준이 없어 두 수준을 찾아 본다(3.1).
- `list`: 읽지 못한 항목은 `invalid` 에 담아 돌려주고 나머지는 정상 반환한다. Task 하나가 손상되었다고 `task status` 전체가 실패하면 안 되기 때문이다.
- 읽기도 `StoreBusyError`(진행 중인 commit 이 끝나기를 기다리다 제한 시간을 넘김)와 `StoreUnavailableError`(저장소 접근 실패)를 던질 수 있다. `readEvents` 도 같다.
- 스냅샷 일관성은 엔티티 하나 단위다. `list` 도중 다른 Task 가 바뀔 수 있다.

### `getBlob(ref)`
- blob 하나를 바이트로 읽는다. 없거나 key 가 blob 문법에 맞지 않으면 `undefined`. 끝난 commit 의 결과만 보인다(2.7). 문법과 파일 위치는 3.3.
- `StoreBusyError`, `StoreUnavailableError` 를 던질 수 있다.

### `readEvents(taskId, { afterSeq })`
- seq 순. `afterSeq` 로 증분 읽기. 없는 Task 면 `TaskNotFoundError`.
- 한 commit 의 이벤트는 전부 보이거나 전혀 보이지 않는다.
- 읽을 때 seq 가 1부터 빈틈없이 증가하는지 확인한다. 중복이나 빈틈이 있으면 `SchemaViolationError(read)` 다. lock 이 깨지는 드문 경우(2.8)를 조용히 넘기지 않고 드러내기 위한 방어선이다.

### 이벤트의 `at`
호출자(commands)가 정한다. Store 는 시계를 읽지 않는다(테스트 용이성). 순서의 기준은 `at` 이 아니라 `seq` 다.

## 2. 파일 구현체 설계

### 2.1 배치 (Task 와 이벤트. 나머지 엔티티와 blob 의 위치는 3.1, 3.3)

```
<dataDir>/
  .locks/T-0001.lock/owner.json     # Task 별 lock. 회수 전용 lock 은 T-0001.reap (git 에 넣지 않음)
  T-0001/
    task.yaml                        # 엔티티 'task'
    events.jsonl                     # 한 줄에 이벤트 하나, LF
    .pending-<token>/commit.json     # 진행 중인 commit 의 기록 (정상 시에는 없음, git 에 넣지 않음)
    .rollbacks                       # 되돌리기 횟수만큼의 바이트. 읽기 표식용 (git 에 넣지 않음)
```

- 엔티티는 YAML, 이벤트는 JSON Lines. 줄바꿈은 항상 LF, 인코딩은 UTF-8.
- `dataDir` 은 구현체 생성자 인자다. 인터페이스에는 나타나지 않는다.
- "Task 가 존재한다" 의 정의: `events.jsonl` 에 seq 1 이 있다. 디렉터리만 있고 이벤트가 없는 것은 버려진 ID 다.
- `.locks/`, `.pending-*/`, `.rollbacks` 를 `devflow-data/.gitignore` 에 추가해야 한다. `devflow-data` 는 다른 repo 이므로 이 구현체를 만든 Task(T-0001)의 범위 밖이고, 후속 작업으로 남겼다(5절 F8).

### 2.2 Lock

원칙: **살아 있는 프로세스의 lock 은 절대 빼앗지 않는다.** 판단이 틀렸을 때 "기록이 조용히 깨지는" 쪽이 아니라 "Task 가 시끄럽게 잠기는" 쪽으로 틀리게 한다. (v2 의 시간 기준 회수는 멈췄다 깨어난 소유자가 새 소유자의 상태를 망가뜨릴 수 있어 폐기했다. `maxHold`, 소유자의 자진 포기, 시계에 의존하는 규칙은 모두 없앴다.)

**획득**
- lock 은 디렉터리 `<dataDir>/.locks/<taskId>.lock` 이고 그 안에 `owner.json` = `{ pid, hostname, platform, token, acquiredAt }` 이 있다. `token` 은 획득마다 새로 만든 난수, `acquiredAt` 은 사람이 읽기 위한 정보일 뿐 판정에 쓰지 않는다.
- **lock 디렉터리는 항상 `owner.json` 과 함께 나타난다**: 임시 디렉터리(`.locks/.tmp-<token>/`)에 `owner.json` 을 먼저 쓴 뒤 lock 경로로 `rename` 한다. 대상이 이미 있으면(비어 있지 않은 디렉터리) rename 이 실패하고, 그것이 "남이 쥐고 있다" 는 신호다. `mkdir` 후에 `owner.json` 을 쓰는 방식은 그 사이에 죽으면 주인 없는 lock 이 남아 시간으로 판정할 수밖에 없어 쓰지 않는다.
- 획득 실패 시 짧은 간격(10~50ms, 지터)으로 재시도하고 제한 시간(기본 5초)을 넘으면 `StoreBusyError`. 임계 구역은 밀리초 단위다.
- OS 의 파일 lock API 는 플랫폼마다 달라 쓰지 않는다.

**해제**: lock 디렉터리를 고유한 이름(`.locks/.tmp-<token>-released-<난수>/`)으로 `rename` 한 뒤 삭제한다. 살아 있는 lock 을 남이 없애는 경로가 없으므로 경로에 있는 것은 항상 자신의 lock 이다. 경로에서 바로 삭제하지 않는 이유: `owner.json` 을 지운 뒤 디렉터리를 지우기 전의 "빈 lock 디렉터리" 가 보이면 안 되기 때문이다(POSIX 에서는 빈 디렉터리 위로의 rename 이 성공해, 뒤따르는 삭제가 새 소유자의 lock 을 지울 수 있다). 회수(아래 4단계)의 삭제도 같은 방식으로 한다.

**stale 판정** — 다음을 모두 만족할 때만 stale 이다.
- `owner.json` 의 `hostname` 과 `platform` 이 자신과 같다.
- 그 `pid` 의 프로세스가 없다(`process.kill(pid, 0)` 이 `ESRCH`). `EPERM` 은 "살아 있음" 이다.

그 밖의 경우는 stale 이 아니다.
- `hostname` 이나 `platform` 이 다르다 → 판정할 수 없다. 빼앗지 않는다. (`platform` 을 보는 이유: WSL 과 Windows 는 hostname 이 같지만 pid 공간이 달라, 상대의 살아 있는 프로세스가 "없음" 으로 보인다.)
- `owner.json` 이 없거나 읽히지 않는다 → 정상 동작으로는 생기지 않는 상태다. 빼앗지 않는다.
- pid 가 살아 있다 → 진짜 소유자이거나, 죽은 소유자의 pid 를 무관한 프로세스가 재사용한 것이다. 구별할 수 없으므로 빼앗지 않는다.

stale 이 아닌 lock 때문에 제한 시간을 넘기면 `StoreBusyError` 의 메시지에 lock 의 내용(pid, 획득 시각)과 안내를 담는다: "다른 devflow 프로세스가 실행 중이 아니라면 `.locks/<taskId>.lock` 을 삭제하라." pid 재사용으로 lock 이 남는 경우의 해결책은 이것뿐이다. 한 사람이 한 머신에서 쓰는 도구에서 받아들일 만한 대가로 판단했다.

**회수 절차** — stale lock 을 없애는 것은 회수 전용 lock 을 쥔 프로세스만 한다. 두 프로세스가 동시에 같은 lock 을 stale 로 판정할 수 있기 때문이다.

1. 대상 lock 의 token 을 기억해 둔다.
2. 회수 전용 lock `.locks/<taskId>.reap` 을 위와 같은 방식(rename)으로 획득한다. 실패하면 다른 프로세스가 회수 중이다 → 일반 재시도 루프로 돌아간다.
3. `.reap` 을 쥔 상태에서 `owner.json` 을 다시 읽는다. token 이 1과 다르거나 더는 stale 이 아니면 아무것도 하지 않는다(다른 프로세스가 이미 회수했고 지금 있는 것은 살아 있는 새 lock 이다).
4. 같으면 lock 디렉터리를 삭제한다.
5. `.reap` 을 삭제하고 일반 재시도 루프로 돌아가 획득을 경쟁한다.

- 3과 4 사이에 경로의 lock 이 바뀔 수 없다. 그 lock 의 주인은 죽었고(해제할 수 없다), 남의 lock 을 없앨 수 있는 것은 `.reap` 을 쥔 자신뿐이기 때문이다. v2 에 있던 "확인 후 삭제" 의 빈틈은 시간 기준 회수가 살아 있는 소유자를 대상으로 삼았기 때문에 생긴 것이다.
- `.reap` 도 lock 과 같은 방식으로(고유 이름으로 rename 후 삭제) 해제한다.
- 회수자가 2~5 사이에 죽으면 `.reap` 이 남는다(crash 복구 도중의 crash). `.reap` 은 자동 회수하지 않는다 — 같은 문제가 한 단계 위에서 되풀이될 뿐이다. 남은 `.reap` 은 stale lock 의 회수만 막고, 그 결과는 `StoreBusyError` 와 수동 삭제 안내다.
- Windows 에서 다른 프로세스가 `owner.json` 을 열고 있는 순간에는 디렉터리 삭제·rename 이 `EPERM`/`EBUSY` 로 실패할 수 있다. 짧게 재시도한다.
- 읽기는 lock 을 잡지 않고 시작한다(2.7).

### 2.3 Task ID 발급

- 전역 lock 을 쓰지 않는다. 현재 최대 `T-NNNN` + 1 을 후보로 `mkdir <dataDir>/T-NNNN` 을 시도하고, `EEXIST` 면 +1 해서 다시 시도한다. `mkdir` 의 원자성이 유일성을 보장한다.
- 그 뒤 해당 Task 의 lock 을 잡고 일반 commit 과 같은 절차로 Task 와 첫 이벤트를 기록한다.
- ADR-0008 결정 4 는 "Task ID 발급을 lock 으로 직렬화한다" 고 적었으나 같은 목적(유일성)을 lock 없이 달성하므로 ADR-0011 이 그 부분을 대체했다.
- 4자리 0 채움, 9999 를 넘으면 자릿수가 늘어난다(스키마 패턴 `^T-[0-9]{4,}$`).

### 2.4 commit 절차

lock 을 잡은 상태에서:

1. `.pending-*/` 이 있으면 복구한다(2.5). 복구가 뒷정리를 마치지 못하면 디스크를 건드리지 않고 `StoreUnavailableError` 로 물러난다.
2. `events.jsonl` 의 마지막 줄에서 `lastSeq` 를 읽는다. 기존 Task 면 Task 디렉터리의 기록 목록을 읽는다(3.4 — ID 발급과 3.2 의 덮어쓰기 방지의 기준). `change` 가 함수면 그 둘로 만든 `CommitContext`(`lastSeq`, `nextId`, `nextArtifactVersion`)로 호출한다.
3. `expectedLastSeq` 검사 → `ConflictError`.
4. writes 와, seq/task_id/commit_id 를 부여한 events 를 전부 스키마 검증 → `SchemaViolationError`. 쓰기 때의 확인(3.1, 3.3, 3.11) → `InvalidChangeError`. 2의 목록과 대 보는 덮어쓰기 방지와 ID 유일성(3.2, 대소문자만 다른 위치 포함) → `AlreadyExistsError`. **여기까지는 디스크를 건드리지 않는다.**
5. `.pending-<token>/` 을 만든다(`token` 은 자신의 lock token). 각 write 를 그 안의 `<n>.tmp` 에, 각 blob 을 `b<n>.tmp` 에 쓰고 fsync. 마지막으로 `commit.json` 을 쓰고 fsync:
   `{ token, firstSeq, lines: [기록할 이벤트 줄 그대로], files: [{ tmp, final }] }` (final 은 Task 디렉터리 기준 상대 경로. blob 도 같은 `files` 에 들어간다)
6. `lines` 를 하나의 버퍼로 `events.jsonl` 에 append 하고 fsync. **`events.jsonl` 의 `firstSeq` 이후가 `lines` 와 정확히 같아진 시점이 commit 시점이다.**
7. 뒷정리: tmp 파일들을 final 위치로 rename. `.pending-<token>/` 삭제.
8. lock 해제.

- `.pending` 의 이름과 내용에 token 을 넣는 것은 방어선이다. 설계상 lock 은 한 번에 한 프로세스만 쥐지만, 그 가정이 깨졌을 때(2.8) 서로의 메모를 덮어쓰지 않고, 복구가 남의 commit 을 자기 것으로 오인하지 않게 한다.

**단계별 실패 처리**

| 실패 지점 | 처리 | `commit()` 의 결과 |
|---|---|---|
| 1~4 | 디스크를 건드리지 않았다 | 해당 오류 |
| 5 | `.pending-<token>/` 을 지운다. 못 지워도 다음 접근의 복구가 지운다(이벤트가 없으므로 되돌리기) | `StoreUnavailableError` (기록 안 됨) |
| 6 | 그 자리에서 2.5 의 복구를 수행해 성립 여부를 판정한다 | 앞으로 굴렸으면 **성공**, 되돌렸으면 `StoreUnavailableError`(기록 안 됨), 판정하지 못하면 `CommitOutcomeUnknownError` |
| 7 | commit 은 이미 성립했다. `.pending-<token>/` 을 남겨 두면 다음 접근이 앞으로 굴린다 | **성공** |
| 8 | lock 이 남는다. 이 프로세스가 끝나면 stale 이 되어 회수된다 | **성공** |

- 인터페이스의 계약은 "`CommitOutcomeUnknownError` 가 아닌 모든 오류는 아무것도 기록되지 않았음을 뜻한다" 이다. 위 표가 그 계약을 지킨다. 원시 I/O 오류는 `StoreUnavailableError` 의 `cause` 로 담아 던진다.
- 7단계의 rename 은 Windows 에서 대상 파일을 다른 프로세스(백신, 에디터, 검색 인덱서, 읽는 중인 reader)가 열고 있으면 `EPERM`/`EBUSY`/`EACCES` 로 실패할 수 있다. 지수 백오프로 최대 1초쯤 재시도하고, 그래도 안 되면 `.pending-<token>/` 을 남긴 채 성공을 돌려준다. (Node 의 `fs.rename` 은 Windows 에서도 기존 파일을 덮어쓴다.)
- `.pending-*/` 이 남아 있는 동안 reader 는 lock 을 잡는 경로로 간다(2.7). 거기서 앞으로 굴리기가 또 실패하면, lock 을 쥔 채 `commit.json` 의 `files` 매핑에 따라 **tmp 의 내용을 읽어** 돌려준다. 성립한 commit 의 결과가 안 보이는 일은 없다.

### 2.5 부분 실패와 복구

`.pending-*/` 이 남아 있으면 이전 commit 이 중간에 죽었거나 뒷정리를 마치지 못한 것이다. lock 을 잡은 프로세스가 **내용을 대조해** 판정한다. `events.jsonl` 에서 `seq = firstSeq - 1` 인 줄의 끝(LF) 다음 바이트부터 파일 끝까지(이하 "꼬리". `firstSeq = 1` 이면 파일 전체)를 `commit.json` 의 `lines` 를 이어 붙인 바이트와 비교한다.

| 꼬리의 상태 | 판정 | 처리 |
|---|---|---|
| `lines` 전체와 정확히 같다 | 성립했다 | **앞으로 굴린다**: 남은 tmp 를 final 로 rename(이미 옮겨진 것은 건너뜀), `.pending-*/` 삭제 |
| 비어 있다, 또는 `lines` 를 이어 붙인 것의 앞부분이다(마지막 줄이 중간에 잘린 경우 포함) | 성립하지 않았다 | **되돌린다**: `.rollbacks` 에 1바이트를 덧붙이고(2.7 의 표식), 꼬리를 잘라내고(꼬리가 파일 전체면 파일을 지운다), `.pending-*/` 삭제 |
| `commit.json` 이 없거나(`ENOENT`) JSON 으로 읽히지 않는다 | 5단계 도중 죽었다. 이벤트는 기록되지 않았다 | `.pending-*/` 삭제 |
| `commit.json` 을 읽다가 그 밖의 오류가 났다 (공유 위반 등) | 알 수 없다 | 아무것도 건드리지 않고 `StoreUnavailableError` |
| 그 밖의 모든 경우 — 꼬리에 `lines` 와 다른 내용이 있다, `lines` 뒤에 줄이 더 있다, `.pending-*/` 이 둘 이상이다 | **판정하지 않는다** | 아무것도 건드리지 않고 `SchemaViolationError(read)` 를 던진다. 메시지에 Task 와 `.pending-*/` 의 위치를 담는다. 사람이 확인해야 한다 |

- 되돌리기가 잘라내는 것은 **자신의 `lines` 와 일치하는 바이트뿐**이다. 다른 프로세스가 성립시킨 이벤트를 지우는 일은 없다(v2 의 "`firstSeq` 이상의 줄을 센다" 는 방식은 이를 구별하지 못했다).
- 마지막 경우는 정상 동작과 프로세스 crash 로는 생기지 않는다. 생겼다면 lock 의 가정이 깨졌거나(2.8), 전원 장애로 파일이 손상되었거나, 사람이 파일을 고친 것이다. 어느 쪽이든 자동으로 고치지 않는다. 그 Task 에 대한 이후의 쓰기와 lock 경로의 읽기는 사람이 정리할 때까지 같은 오류를 낸다.
- 복구는 몇 번을 수행해도 결과가 같다. 복구 도중에 죽으면 다음 접근이 같은 복구를 처음부터 다시 한다. 복구는 lock 을 쥔 프로세스만 수행한다.
- "append-only" 는 **성립한 commit 의 이벤트**에 대한 규칙이다. 성립하지 않은 commit 의 잔여물을 잘라내는 것은 위반이 아니다. `AGENTS.md` 7번은 이 해석을 담도록 고쳐졌다(ADR-0011). `devflow-data/README.md` 의 문구는 아직 그렇지 않다(5절 F10).

### 2.6 검증 시점

- 쓰기: 2.4 의 4단계. `ajv`(draft 2020-12) + `ajv-formats`. 스키마 로더는 `src/schema/registry.mjs` 하나다(ADR-0016): 처음 쓸 때 `schemas/` 의 스키마를 모두 등록하고(스키마가 파일을 가로질러 `$ref` 한다), 이름마다 처음 꺼낼 때 한 번 컴파일한다. Store 는 `src/schema/validator.ts` 를 거쳐 쓴다.
- 읽기: 파싱 직후 매번. 사람이 파일을 손으로 고칠 수 있는 0~1단계에서는 특히 필요하다. 성능이 문제가 되면 (mtime, size) 기준 캐시를 구현체 내부에 둘 수 있다.

### 2.7 읽기 절차

reader 는 lock 없이 시작하되, commit 과 겹쳤을 가능성이 있으면 결과를 버린다. (v1 의 "`.pending` 이 안 보이면 그냥 읽는다" 는 확인과 읽기 사이에 commit 이 시작될 수 있어 틀렸다.)

표식은 두 가지다.
- **S** = (`events.jsonl` 의 크기, `.rollbacks` 의 크기). `events.jsonl` 이 없거나 크기가 0 이면 "없음" 이다. `.rollbacks` 는 되돌리기(2.5)를 할 때마다 1바이트씩 늘어나는 카운터 파일이다.
- **P** = `.pending-*/` 의 존재 여부.

S 는 **파일 시각에 의존하지 않는다.** v3 까지는 (크기, mtime) 이었으나 실측에서 mtime 전제가 깨졌다(2.9 의 I2): NTFS 에서 append 직후 mtime 이 그대로인 경우가 있고, "append 후 잘라내기" 가 원래와 같은 (크기, mtime) 을 남긴 경우가 2000회 중 863회였다. 성립한 commit 은 `events.jsonl` 의 크기를, 되돌리기는 `.rollbacks` 의 크기를 반드시 늘리고 두 값 모두 줄어들지 않으므로 같은 역할을 시각 없이 해낸다.

1. 앞 표식을 **S, P 순서로** 읽는다.
2. 앞 표식에서 P 가 없고 S 가 "없음" 이 아니면 대상을 읽는다(엔티티 파일, blob, `events.jsonl` 전체, 또는 `list`·`get` 이 자리를 찾는 디렉터리 목록). 읽다가 난 오류는 일단 보관한다.
3. 뒤 표식을 **P, S 순서로** 읽는다.
4. 앞뒤 모두 P 가 없고 S 가 같으면 겹치지 않은 읽기다. S 가 "없음" 이면 그 Task 는 존재하지 않는다(버려진 ID 이거나 `createTask` 가 아직 메모를 쓰기 전이다): `get` 은 `undefined`, `list` 는 건너뜀, `readEvents` 는 `TaskNotFoundError`. 아니면 읽은 내용을 돌려주고, 보관한 오류가 있으면 그것이 진짜 오류이므로 던진다.
5. 아니면 짧은 백오프로 1부터 다시 한다(최대 3회 더). 그래도 안 되면 **lock 을 잡고** 읽는다. lock 을 잡으면 commit 이 끝나기를 기다린 셈이고, 죽은 commit 이 있었다면 복구(2.5)를 수행한 뒤 읽게 된다. 복구가 뒷정리를 마치지 못하면(`forward-incomplete`) tmp 의 내용을 읽어 돌려준다(2.4).

왜 충분한가: 읽는 순서 때문에 시각은 S앞 < P앞 < 읽기 < P뒤 < S뒤 다. 어떤 commit 의 `.pending` 구간(5단계에서 생겨 7단계 끝 또는 되돌리기 끝에 사라진다)이 읽기와 겹쳤는데 P앞 과 P뒤 가 모두 "없음" 이었다면, 그 구간 전체가 P앞 과 P뒤 사이에 들어 있다. 그 commit 이 성립했다면 6단계의 append 가, 되돌려졌다면 `.rollbacks` 의 증가가 S앞 과 S뒤 사이에 있으므로 S 가 달라진다. 따라서 4를 통과한 읽기는 어떤 commit 과도 겹치지 않았다. 잘린 줄, 나중에 되돌려질 이벤트, 한 commit 의 이벤트 일부, 이벤트는 있는데 엔티티는 옛것인 상태 중 어느 것도 보이지 않는다.

- 진행 중인 commit 이 있으면(P 가 보이면) reader 도 그것이 끝나기를 기다린다. 정상적인 commit 은 밀리초 단위라 보이지 않지만, 소유자가 lock 을 쥔 채 멈춰 있으면 읽기도 제한 시간 뒤 `StoreBusyError` 가 된다.
- `list` 는 Task 마다 이 절차를 따로 수행한다.
- 읽기 전용 매체(또는 쓰기 권한이 없는 사용자)에서는 5의 lock 경로를 쓸 수 없다. lock 을 만들지 못해 `StoreUnavailableError` 가 된다. 읽기 전용 소비자는 지원 대상이 아니다.

### 2.8 한계

- **전원 장애에 대한 내구성은 보장하지 않는다.** 보장하는 것은 프로세스 crash 에 대한 원자성이다. Windows 에서는 디렉터리 fsync 가 불가능해 rename 과 삭제의 내구성이 NTFS 저널에 달려 있다. `devflow-data` 가 git repo 이고 Step 전이마다 commit 되므로(ADR-0007) 최악의 경우 마지막 git commit 으로 돌아갈 수 있다.
- **한 호스트, 한 플랫폼에서만 쓴다.** 여러 호스트가 같은 `dataDir`(공유 폴더, 네트워크 드라이브)을 쓰거나 Windows 와 WSL 이 같은 `dataDir` 을 함께 쓰는 것은 지원하지 않는다. 서로의 lock 을 빼앗지는 않지만(2.2), 상대가 죽으며 남긴 lock 은 수동으로 지워야 한다. 여러 호스트가 필요해지는 시점이 DB 구현체로 넘어갈 시점이다(roadmap 4단계).
- **사람이 lock 을 지워야 하는 경우가 있다**: 죽은 소유자의 pid 가 재사용된 경우, 회수 도중 죽어 `.reap` 이 남은 경우. 둘 다 `StoreBusyError` 의 메시지가 안내한다.
- **두 프로세스가 동시에 lock 을 쥐게 되는 경로는 설계상 없다.** 남는 것은 설계 밖의 경로다: 사람이 살아 있는 프로세스의 lock 을 지운 경우, hostname 과 platform 이 같은데 pid 공간이 다른 환경(같은 Windows 호스트의 서로 다른 WSL2 배포판, hostname 을 공유하도록 설정된 컨테이너 등). 이때의 방어선은 세 겹이다 — token 이 들어간 `.pending`(서로의 메모를 덮어쓰지 않는다), 내용을 대조하는 복구(남의 이벤트를 자르거나 확정하지 않고 오류로 멈춘다), `readEvents` 의 seq 연속성 검사. 이 방어선은 피해를 **드러내는** 것이지 막는 것이 아니다.

### 2.9 구현에서 확정·확인한 것

T-0001 의 step-002 에서 구현하고 테스트하며 확정한 내용이다(I6 은 T-0005 에서 바뀐 지금의 규약). 환경: Windows 11, NTFS, Node 22.

| # | 항목 | 결과 |
|---|---|---|
| I1 | 기존 디렉터리 위로의 디렉터리 `rename` | **성립.** Windows 에서는 대상이 비어 있든 아니든 `EPERM` 으로 실패한다(POSIX 는 비어 있지 않으면 `ENOTEMPTY`). `EPERM` 은 백신 간섭 같은 일시적 오류와 코드가 같으므로, 획득 실패 뒤 `owner.json` 을 읽어 구별한다: 소유자가 있으면 "쥐고 있다", lock 디렉터리가 없으면 일시적 오류이거나 방금 해제된 것이므로 곧바로 재시도한다 |
| I2 | 파일 시각 기반 표식 | **불성립 → 교체.** 2.7 의 S 를 (`events.jsonl` 크기, `.rollbacks` 크기)로 바꿨다 |
| — | `process.kill(pid, 0)` | **성립.** 살아 있으면 성공, 끝났으면 `ESRCH`. 부작용 없음 |
| I3 | 장애 재현 방법 | 파일 시스템 연산을 `FileOps` 인터페이스 뒤에 두었다. I/O 오류는 테스트가 `FileOps` 를 감싸 주입하고, crash 는 **실제 자식 프로세스를 그 지점에서 `process.exit` 시켜** 만든다(lock 과 `.pending` 이 남은 채 pid 가 죽는다). 2.4 와 2.5 의 표의 각 행에 테스트가 있다 |
| I4 | 동시성 테스트 | 별도 프로세스 6개를 barrier 파일로 동시에 출발시킨다. 같은 Task 에 90개의 commit, 동시 `createTask` 48개. 이벤트가 프로세스 간에 섞였는지도 확인해 경합이 실제로 일어났음을 보인다 |
| I5 | 기본값 | lock 제한 시간 5초, 획득 재시도 간격 10~50ms(방금 해제된 경우 1ms), rename/삭제의 일시적 오류 재시도는 지수 백오프로 총 1초. `FileStoreOptions` 의 `lockTimeoutMs`, `transientRetryMs` 로 바꾼다 |
| I6 | `CommitOutcomeUnknownError` 뒤의 확인 규약 | 오류의 `firstSeq` 로 `readEvents({ afterSeq: firstSeq - 1 })` 를 읽어 `commit_id` 가 오류의 `commitId` 와 같은 이벤트를 고른다. 없으면 성립하지 않았고, 보낸 개수만큼 `firstSeq` 부터 이어지며 내용이 같으면 성립했다. 절차는 `docs/design/commands.md` 3절, 구현은 `src/commands/outcome.ts` 의 `confirmOutcome`. T-0001 에서는 내용 비교였고 T-0005 에서 commit 식별자로 바꿨다(3.5, 5절 F12) — 같은 자리에 내용이 같은 다른 commit 의 이벤트가 있어도 식별자가 다르므로 오인하지 않는다 |
| I7 | `StoreBusyError` 의 안내 | `detail` 에 소유자의 pid 와 획득 시각, 지워야 할 경로(`.lock`, 남아 있다면 `.reap`), "다른 devflow 프로세스가 실행 중이 아닌 것을 확인한 뒤" 라는 조건을 담는다 |

구현하며 추가로 정한 것:

- **꼬리의 정의(2.5)**: `seq = firstSeq - 1` 인 줄의 LF 다음 바이트부터 파일 끝까지. `firstSeq = 1` 이면 0부터. 잘린 마지막 줄은 seq 를 읽을 수 없으므로 seq 가 아닌 바이트 위치로 정의해야 한다. 이것을 `lines` 를 이어 붙인 UTF-8 바이트와 비교한다.
- **`commit.json` 을 읽지 못하는 경우의 구분(2.5)**: "없음(`ENOENT`)" 과 "JSON 으로 읽히지 않음" 만 메모 쓰기 도중의 crash 로 보고 버린다. 그 밖의 읽기 오류(Windows 의 공유 위반 등)는 아무것도 건드리지 않고 `StoreUnavailableError` 다. 같은 것으로 처리하면 성립한 commit 의 엔티티 쓰기를 조용히 잃는다.
- **이전 commit 의 뒷정리가 끝나지 않으면 다음 commit 을 쌓지 않는다(2.4 의 1단계)**: 디스크를 건드리지 않고 `StoreUnavailableError` 로 물러난다. 계속 진행하면 `.pending` 이 둘이 되어 lock 의 가정이 깨지지 않았는데도 2.5 의 "판정하지 않는다" 에 도달한다.
- **`createTask` 가 되돌려지면 빈 `events.jsonl` 을 지운다.** 남더라도 크기 0 은 "없음" 으로 취급한다(2.7).
- **`.reap` 도 lock 과 같은 방식으로(고유 이름으로 rename 후 삭제) 해제한다.**
- **해제에 실패한 lock 은 그 Store 인스턴스가 기억한다.** 그래서 Store 는 프로세스마다 하나만 만든다(`docs/design/commands.md` 5절): 인스턴스가 둘이면 한쪽이 남긴 lock 을 다른 쪽은 살아 있는 남의 lock 으로 보고 제한 시간 뒤 `StoreBusyError` 가 된다. 오래 사는 프로세스에서는 자신의 pid 가 살아 있어 stale 로 회수되지 않으므로, 다음 획득 때 경로의 lock 이 자신이 해제하지 못한 token 이면 직접 정리한다. 같은 프로세스의 획득자 여럿이 동시에 정리하려 들 수 있으므로 프로세스 안에서 직렬화하고, 그 안에서 token 을 다시 확인한 뒤에만 없앤다(회수 절차와 같은 구조다). 정리도 계속 실패하면 제한 시간 뒤 `StoreBusyError` 다.
- **획득 루프의 모든 경로는 제한 시간 검사를 거친다.** 회수를 시도했거나 자신의 lock 을 정리한 뒤에도 마찬가지다. 남은 `.reap` 때문에 회수가 되지 않는 경우에 2.2 가 말한 `StoreBusyError` 와 안내에 도달하려면 이것이 필요하다.
- **회수하려는 stale lock 을 다른 프로그램이 붙들고 있어 옮기지 못하면** 길을 트지 못한 것으로 보고 제한 시간 뒤 `StoreBusyError` 와 안내로 끝난다. 자신의 lock 을 정리하지 못한 경우와 같은 결과다.
- **lock 준비에 실패하면 준비용 디렉터리를 스스로 지운다.** 빈 준비용 디렉터리는 청소 대상이 아니므로 남기면 쌓인다.
- **lock 을 준비하는 단계의 I/O 오류도 `StoreUnavailableError` 다.** `.locks/` 생성, 찌꺼기 청소, 준비용 디렉터리 쓰기가 모두 포함된다. 읽기 전용 매체에서의 쓰기와 lock 경로의 읽기가 여기에 해당한다.
- **찌꺼기 청소**: 획득 준비용·해제용 임시 디렉터리(`.locks/.tmp-*`)가 crash 로 남으면, 프로세스마다 첫 획득 때 **소유자가 죽은 것이 확인된 것만** 지운다. `owner.json` 이 아직 없는 디렉터리는 살아 있는 프로세스가 막 준비하는 중일 수 있으므로 건드리지 않는다(그 상태로 죽은 것은 무해한 빈 디렉터리로 남는다).
- **commit 은 줄 수와 마지막 seq 가 같은지 확인한다.** seq 는 1부터 빈틈없으므로 둘은 같아야 한다. 다르면 로그의 중간이 손상된 것이므로 그 위에 commit 을 더 쌓지 않고 `SchemaViolationError(read)` 로 멈춘다.
- **엔티티의 상대 위치는 항상 `/` 로 구분한다.** `commit.json` 의 `files[].final` 에 그대로 저장되므로 `dataDir` 을 다른 OS 로 옮겨도 복구가 읽을 수 있어야 한다.

## 3. 나머지 엔티티 (T-0005 에서 확정한 설계)

T-0005 에서 확정하고 구현한 것이다 — 설계는 step-001, 스키마 쪽(artifact 의 `stored_in`, event 의 `commit_id` 등)은 step-002, Store 와 commands 는 step-003, 대소문자만 다른 key·이름의 처리는 step-004. 코드는 `src/store/types.ts`, `errors.ts`, `blob-ref.ts`, `file/layout.ts`, `file/file-store.ts` 이고, 구현하며 정한 것과 설계에서 더 좁힌 것은 3.11 에 있다. 구조를 바꾼 결정과 포기한 대안은 ADR-0015(Store)·ADR-0016(스키마 로더), 근거(기존 기록의 조사, 실험)는 각 Step 의 작업 노트에 있다.

원칙은 T-0001 에서 정한 그대로다 — **기존 메서드(`createTask`, `commit`, `get`, `list`, `readEvents`)의 시그니처는 바꾸지 않고 추가만 한다.** 새 kind 는 `EntityMap` / `EntityKeyMap` / `EntityScopeMap` 의 항목으로, 새 기능은 `CommitContext`·`Change`·`CommitResult` 의 멤버와 새 메서드 `getBlob` 으로 더했다. 파일 위치는 파일 구현체만 안다(AGENTS.md 2번). 아래 표의 "파일 위치" 열은 파일 구현체의 규칙이고, 인터페이스에는 key 와 scope 만 나타난다.

### 3.1 kind 별 key·scope·파일 위치

파일 위치는 Task 디렉터리(`<dataDir>/T-NNNN/`) 기준이다.

| kind | key | scope (list) | 파일 위치 | 불변 |
|---|---|---|---|---|
| `task` | `{ taskId }` | `{ status? }` | `task.yaml` | 아니다 |
| `step` | `{ taskId, stepId }` | `{ taskId, status? }` | `steps/<stepId>/step.yaml` | 아니다 |
| `decision` | `{ taskId, id }` | `{ taskId }` | `decisions/<id>.yaml` | **불변** |
| `feedback` | `{ taskId, id }` | `{ taskId, stepId?, kind? }` | `step_id` 가 있으면 `steps/<step_id>/feedback/<id>.yaml`, 없으면 `feedback/<id>.yaml` | 아니다 |
| `run` | `{ taskId, id }` | `{ taskId, stepId?, role? }` | `step_id` 가 있으면 `steps/<step_id>/runs/<id>.yaml`, 없으면 `runs/<id>.yaml` | 아니다 |
| `gate_result` | `{ taskId, stepId, id }` | `{ taskId, stepId? }` | `steps/<stepId>/gates/<id>.yaml` | **불변** |
| `artifact` | `{ ref }` (`artifact://<task>/<step>/<name>@v<N>`) | `{ taskId, stepId?, name? }` | `steps/<step>/artifacts/<name>/v<N>.meta.yaml` | **불변** |
| (blob) | `blob:<key>` 문자열 | — | 3.3 | **불변** |

- **ID 의 모양**: Step `step-NNN`, Decision `D-NNN`, Feedback `F-NNN`, Run `R-NNN`, GateResult `G-NNN`(모두 3자리 0 채움, 999 를 넘으면 자릿수가 늘어난다), Artifact 버전은 1부터의 정수. 파일 구현체는 ID 를 파일 이름으로 쓰므로 쓰기 전에 이 모양을 확인한다(아니면 `InvalidChangeError`).
- **ID 는 Task 안에서 kind 마다 유일하다.** Step 수준과 Task 수준이 번호를 나눠 쓴다(예: T-0002 의 Run 은 Task 수준 R-001·R-006, Step 수준 R-002~R-005). GateResult 의 번호도 Step 을 가로질러 이어진다(T-0001 의 G-001~G-007). 기존 기록 T-0001~T-0005 에 겹치는 ID 는 없다.
- **Run·Feedback 의 key 에는 stepId 가 없다 (G-001 의 첫째 우려).** 두 수준이 있는 kind 는 key 가 Task 안의 ID 이고, 수준(어느 Step 에 속하는지)은 값의 `step_id` 필드다. 쓸 때는 값의 `step_id` 로 위치가 정해진다. `get` 은 파일 구현체가 `runs/<id>.yaml` 과 `steps/*/runs/<id>.yaml` 을 찾아 본다 — 없으면 `undefined`, 하나면 그것, 둘 이상이면 손상이므로 `SchemaViolationError(read)`. key 에 stepId 를 넣지 않은 이유: Run·Feedback 은 기록 곳곳에서 ID 만으로 가리켜진다(`Artifact.run_id`, `GateResult.reviewer_run_id`, `Decision.planner_run_id`, `Feedback.target.run_id`, `Feedback.response_run_id`, AC 의 `added_by`). 호출자가 수준을 몰라도 찾을 수 있어야 하고, DB 의 기본 키도 `(task_id, id)` 가 된다.
- **GateResult 는 key 에 stepId 를 둔다.** Gate 는 언제나 Step 수준이고, 가리키는 문법(`gate://<task>/<step>/<gate-id>`)이 Step 을 담고 있다. ID 가 Task 안에서 유일하다는 규칙은 같다.
- **scope 의 `stepId`**: `feedback`·`run` 에서 생략하면 두 수준 모두, `null` 이면 Task 수준만, 문자열이면 그 Step 만. `gate_result`·`artifact` 에서 생략하면 Task 의 모든 Step.
- **`list` 는 이름이 그 kind 의 모양인 파일만 읽는다.** `runs/` 에서는 `R-NNN.yaml` 만 Run 이고, `gates/` 에서는 `G-NNN.yaml` 만 GateResult 다. 같은 디렉터리의 다른 파일(`R-002.work-notes.md`, `R-003.output.json`, `G-001.deterministic.md` 등)은 blob 이므로 어떤 kind 의 `items` 에도 `invalid` 에도 세지 않는다. 모양이 맞는데 스키마를 위반한 파일은 `invalid` 에 담긴다(1절). 순서는 ID 의 번호 순, Artifact 는 (Step, 이름, 버전) 순.
- **쓰기 때의 추가 확인**(모두 `InvalidChangeError` — 호출자의 버그): 값의 `task_id` 가 commit 의 Task 와 같다(T-0001 부터), Artifact 의 `ref` 가 `task_id`·`step_id`·`name`·`version` 과 맞는다, 한 Change 안에 같은 key 를 두 번 쓰지 않는다. 구현에서 더한 것은 3.11.
- **Store 가 다루지 않는 파일**: `ledger.md`, T-0004 의 `intent.md`, 데이터 repo 최상위의 `projects.yaml`·`backlog.md`·`README.md`. `list` 는 이것들을 보지 않는다. Ledger 를 Store 로 옮기는 것은 이 Task 의 범위가 아니다.

**README 의 배치와 실제 기록이 다른 곳 — 실제 기록을 따른다.** 이유: 기존 기록을 고치지 않고 모든 kind 로 읽어야 하고(T-0005 의 S5, S6), 기존 기록의 `content_key` 가 이미 실제 파일(`runs/R-NNN.work-notes.md`)을 가리킨다. README 는 이 Task 가 merge 된 뒤 이 절에 맞춘다.

| README | 실제 기록 (T-0001~T-0005) | 이 설계 |
|---|---|---|
| 문서 본문 `artifacts/<name>/v1.md` | 없다. 본문은 그것을 만든 Run 의 `runs/R-NNN.work-notes.md` 이고 meta 의 `content_key` 가 가리킨다 | 실제를 따른다. 문서 본문은 만든 Run 이 소유한 blob 이다(3.3). `v<N>.md` 는 쓰지 않는다 |
| Gate 로그 `gates/G-001.logs/` | 없다. `gates/G-NNN.deterministic.md` 가 있다 | 실제를 따른다. Gate 의 로그는 그 Gate 가 소유한 blob `G-NNN.<name>` 이다 |
| `runs/R-002.transcript.jsonl` | 없다(transcript 를 남긴 적이 없다) | 3.3 의 규칙이 그대로 받는다(`R-002.transcript.jsonl` 은 `transcript` + `.jsonl`) |
| 없음 | `runs/` 의 `R-NNN.output.yaml`(Task 수준), `R-NNN.output.json`, `.probe.md`, `.failed.md`, `.partial.diff` | 모두 Run 이 소유한 blob 이다 |
| `feedback/`, `runs/`(Task 수준) | 있다 | 같다 |

### 3.2 덮어쓰기 방지

**불변은 kind 별로 Store 의 계약으로 정한다.** 쓰기마다 모드를 주지 않는다 — Change 의 모양과 `commit` 의 시그니처가 그대로이고, 호출자가 모드를 빠뜨려 덮어쓰는 길이 없고, DB 구현체에서는 insert-only 제약으로 옮겨진다.

| kind | 불변 | 근거 (데이터 repo 의 git 이력에서 같은 파일이 다시 쓰였는가) |
|---|---|---|
| `artifact` | 불변 | 다시 쓰인 것은 승인 때의 `approved: false → true` 뿐이다(아래). 산출물의 버전은 한 번 만들면 바뀌지 않아야 승인이 "특정 버전" 을 가리킬 수 있다(AGENTS.md 8번) |
| `gate_result` | 불변 | 다시 쓰인 적이 없다. 특정 버전에 대한 판정이다 |
| `decision` | 불변 | 다시 쓰인 적이 없다. Planner 의 원래 제안이다. `human_edit` 을 나중에 채우는 쓰임과는 부딪친다 — 사람이 불변을 골랐고(T-0005 F-001) `human_edit` 의 자리는 5절 F2 와 함께 나중에 정한다 |
| blob | 불변 | 다시 쓰인 적이 없다. 엔티티가 key 로 가리키는 내용이다 |
| `task`, `step`, `run` | 가변 | `step.yaml` 36회, Run 20회, `task.yaml` 4회 다시 쓰였다(상태 전이, 종료 시각, packet_gaps — T-0005 step-001 이 센 수) |
| `feedback` | 가변 | 다시 쓰인 적은 없지만 스키마가 나중에 채우는 필드를 가진다(`response`, `response_source`, `response_run_id`, `promoted_to`) |

- **계약**: 불변 kind 의 이미 있는 key 에 쓰거나 이미 있는 blob key 에 쓰는 commit 은 `AlreadyExistsError` 로 거부된다. 그 commit 의 어떤 쓰기도 이벤트도 기록되지 않는다(1절의 "`CommitOutcomeUnknownError` 가 아닌 모든 오류는 아무것도 기록되지 않았음을 뜻한다" 에 들어간다). 내용이 같아도 거부한다.
- **Task 안의 ID 유일성도 같은 오류다**: 다른 자리(다른 수준이나 다른 Step)에 같은 ID 의 기록이 있으면 가변 kind 라도 `AlreadyExistsError` 다. 예: Step 수준의 R-002 가 있는데 `step_id` 없는 R-002 를 쓰는 것, step-001 에 G-003 이 있는데 step-002 의 G-003 을 쓰는 것. 가변 kind 가 같은 자리의 같은 key 에 쓰는 것은 교체다.
- **대소문자만 다른 key·이름도 같은 오류다 (대소문자를 가리지 않는 파일 시스템의 처리).** Artifact 이름과 blob 의 label 은 대소문자를 가리고 대문자를 받는다(스키마의 문법 그대로). 그러나 NTFS 나 기본 설정의 macOS 처럼 대소문자를 가리지 않는 파일 시스템에서는 `plan` 과 `Plan` 의 디렉터리, `R-001.Notes.md` 와 `R-001.notes.md` 가 한 곳이 되어 불변 기록이 덮어쓰인다. 그래서 파일 구현체는 쓰려는 파일과 그 위의 디렉터리를 lock 안에서 읽은 목록과 대소문자를 무시하고도 대 보아, 철자가 대소문자만 다른 것이 **디스크에 있으면 `AlreadyExistsError`, 같은 Change 안에 있으면 `InvalidChangeError`** 로 거부한다. 같은 Step 의 Artifact 는 버전이 달라도 거부된다(`plan@v1` 이 있으면 `Plan@v2` 도 — 같은 디렉터리에 들어가기 때문이다). **파일 시스템이 대소문자를 가리든 아니든 늘 거부한다** — 동작이 OS 에 따라 달라지지 않게 하려는 것이다. 다른 Step 의 같은 이름, 다른 소유자·다른 Step 의 같은 label 은 부딪치지 않는다. 읽기 쪽은 3.11.
- `AlreadyExistsError` 를 따로 두는 이유: `ConflictError`(다시 읽고 판단해 재시도), `InvalidChangeError`(버그)와 호출자가 할 일이 다르다. 결과를 모르는 채 다시 보낸 Gate 기록처럼 "이미 있다" 가 곧 원하던 상태일 수 있다 — 호출자는 `get` 으로 확인할 수 있다.
- **파일 구현체**: 2.4 의 4단계(lock 안, 디스크를 건드리기 전)에서 확인한다. 1단계의 복구가 끝난 뒤이므로 디스크가 기준이다(뒷정리가 남은 경우에는 commit 을 쌓지 않고 물러난다 — 2.9).
- **Artifact 의 `approved` — 승인은 Artifact 밖의 기록(`kind: approval` 인 Feedback 과 `artifact.approved` 이벤트)으로만 나타낸다.** 사람이 T-0005 step-001 의 승인(F-001)에서 (A) 를 골랐다. Store 는 Artifact meta 를 다시 쓰지 않고(approved 만 바꾼 meta 도 `AlreadyExistsError`), artifact 스키마의 `approved` 는 옛 기록을 읽기 위한 필드다(step-002 에서 설명을 바꾸고 `default` 를 뺐다). 0단계는 승인 때 meta 의 `approved` 를 같은 파일에서 `false → true` 로 다시 써 왔고, 그렇게 쓴 승인마다 승인 Feedback 과 `artifact.approved` 이벤트도 있다 — 데이터 repo HEAD `6a438a8` 에서 meta 40개 가운데 `approved: true` 25개, 승인 Feedback 25개, `artifact.approved` 이벤트 25개(T-0005 step-004 가 셌다. 기록이 늘면 바뀐다). 포기한 (B) "`false → true` 한 방향 전이만 허용" 과 (C) "승인을 별도 기록으로" 는 ADR-0015 에 있다. merge 뒤 0단계의 승인 절차에서 meta 를 고치는 단계가 빠진다(Task 밖).

### 3.3 blob

문서 본문, 작업 노트, Run 의 출력 파일, 실측 기록, 검증 로그, transcript 처럼 엔티티가 key 로 가리키는 내용이다. 엔티티가 아니므로 `get`/`list` 의 kind 가 아니다.

**key 의 문법**은 새로 만들지 않았다 — step 스키마의 `blob:<key>` 문법과 기존 기록의 `content_key`·`work_notes_key`(예: `blob:T-0004/step-001/R-002.work-notes`) 그대로다. 그 문법 안에서 Store 가 쓰는 key 는 다음 모양이다.

```
blob:<taskId>/<stepId>/<owner>.<name>     Step 수준
blob:<taskId>/<owner>.<name>              Task 수준 (Run 만)
  <owner> = R-NNN (Run) | G-NNN (GateResult)       — blob 을 소유한 기록
  <name>  = <label> | <label>.<ext>
  <label> = 영숫자로 시작하고 영숫자·_·- 만 (점 없음). <ext> 와 md 는 label 이 될 수 없다
  <ext>   = json | yaml | jsonl | diff | txt | log
```

**key → 파일** (파일 구현체):

- 소유자가 `R-` 면 `runs/`, `G-` 면 `gates/`. `<stepId>` 가 있으면 `steps/<stepId>/` 아래, 없으면 Task 디렉터리 바로 아래. Gate 는 언제나 Step 수준이다.
- 파일 이름은 `<owner>.<name>` 이고, `<ext>` 가 없으면(Markdown) 뒤에 `.md` 를 붙인다. `.md` 를 key 에 쓰지 않는 것은 기존 key(`R-002.work-notes`, `R-005.probe`)가 그렇게 쓰였기 때문이다.
- label 에 점을 금하고 확장자를 label 로 금하는 이유: `R-002.yaml`(Run 기록 자체)이나 `R-002.work-notes.md` 를 key 로 만들 수 있으면 한 파일이 두 key 로, 또는 엔티티와 blob 으로 동시에 읽힌다. 이 규칙이면 파일과 key 가 일대일이다.
- 기존 기록의 runs/·gates/ 에서 기록이 아닌 파일은 모두 이 규칙으로 풀린다. step-001 의 실험에서 47개(이름별: `work-notes` 16, `output.yaml` 10, `output.json` 9, `deterministic` 9(gates/), `probe` 1, `failed` 1, `partial.diff` 1)와 기록이 key 로 가리키는 17개(`content_key`, `work_notes_key`, Step 의 inputs)가 풀렸고, 구현 뒤에는 `npm run check-store-read` 가 데이터 repo 의 모든 그런 파일을 `getBlob` 으로 읽어 확인한다(3.11 — 수는 기록이 늘면 바뀐다).
- **대소문자**: key 는 대소문자를 가린다(`R-001.Notes` 와 `R-001.notes` 는 다른 key 다). 대소문자를 가리지 않는 파일 시스템에서는 두 key 가 한 파일이 되므로, 대소문자만 다른 key 의 blob 이 이미 있으면 `AlreadyExistsError`, 같은 Change 안에 있으면 `InvalidChangeError` 다(파일 시스템과 상관없이 — 3.2). `getBlob` 은 key 의 철자 그대로인 파일만 읽는다(3.11).

**쓰기 — commit 안에서 한다.** `Change.blobs` 에 담으면 엔티티 쓰기와 같은 절차(2.4 의 tmp → rename)로 같은 commit 에 원자적으로 기록된다. T-0001 의 방향("commit 밖에서 먼저 쓰고 key 를 엔티티에 담아 commit")을 바꾼 이유:

- 소유자의 ID 가 commit 안에서 발급된다(3.4). Gate 의 로그 `G-NNN.deterministic` 은 그 Gate 의 ID 를 알아야 쓸 수 있는데 ID 는 `nextId` 로 commit 안에서야 정해진다. commit 밖에서 먼저 쓰려면 ID 를 미리 짐작해야 하고, 짐작이 틀리면 남의 Gate 의 blob 자리를 차지한다.
- 엔티티와 그것이 가리키는 blob 이 함께 기록되거나 함께 기록되지 않는다. 참조되지 않는 blob 도, 없는 blob 을 가리키는 엔티티도 생기지 않는다.
- 불변 검사(이미 있는 key 인가)를 lock 안에서 엔티티와 같은 방식으로 한다. lock 밖에서 no-clobber 생성을 따로 보장할 필요가 없다.
- 대가: 큰 blob(transcript)을 쓰는 동안 그 Task 의 lock 을 쥔다. 파일 구현체의 commit 이 밀리초에서 그 파일을 쓰는 시간만큼 길어진다.

쓸 때 확인하는 것: 소유자의 `taskId` 가 commit 의 Task 와 같다, `name` 이 위 문법에 맞는다, 한 Change 에 같은 key(또는 대소문자만 다른 key)가 두 번 없다(모두 `InvalidChangeError`), key(또는 대소문자만 다른 key)가 이미 없다(`AlreadyExistsError`). 소유자 기록(Run, GateResult)이 이미 있는지는 확인하지 않는다 — Gate 와 그 로그처럼 같은 commit 에서 함께 생길 수 있다.

**읽기** — `getBlob(ref)`: 없으면 `undefined`. 문법에 맞지 않는 key 도 `undefined`(그런 blob 은 없다). 2.7 의 읽기 절차를 따르므로 commit 과 겹친 읽기는 버리고, 뒷정리가 남은 경우 `.pending` 의 tmp 를 읽는다. 내용은 바이트로 돌려주고 해석(UTF-8, JSON 등)은 호출자가 이름으로 안다.

호출자가 commit 전에 key 를 알아야 엔티티(`content_key`, `log_key`)에 담을 수 있으므로, key 를 만드는 순수 함수 `blobRef(owner, name)` 을 인터페이스 쪽(`src/store/`, 파일 지식 없음)에 둔다. key 의 문법은 인터페이스의 일부이고 파일 위치는 아니다.

### 3.4 Task 안의 ID 발급

- `commit` 의 함수 형태가 받는 `CommitContext` 에 `nextId(kind)` 와 `nextArtifactVersion(stepId, name)` 이 있다. `createTask` 의 `build` 에는 없다(첫 commit 은 Task 와 이벤트만 쓴다).
- **규칙**: kind 마다 Task 안에서 이미 있는 가장 큰 번호의 다음. 빈 번호를 채우지 않는다. Run·Feedback 은 두 수준을 합쳐서, GateResult 는 모든 Step 을 합쳐서 센다. blob 의 소유자 ID(`R-012.failed.md` 의 R-012 등)도 센다 — 기록 없이 blob 만 있는 ID 를 다시 내주면 그 blob 과 부딪치기 때문이다. Artifact 버전은 (Step, 이름) 마다 `v<N>.meta.yaml` 의 가장 큰 N 의 다음(1부터). 이름은 철자 그대로 센다 — 대소문자만 다른 이름은 따로 세지만 그 이름으로 쓰는 commit 은 3.2 대로 거부된다(3.11).
- **같은 컨텍스트에서 다시 부르면 다음 번호**를 준다(한 commit 에서 Run 둘을 만드는 경우). 함수가 다시 호출되면(구현체의 재시도) 새 컨텍스트로 처음부터 센다.
- **동시 commit 에서 겹치지 않는 이유**: 번호는 Task 의 lock 을 쥔 뒤의 디스크 상태로 세고, 발급한 ID 의 기록은 같은 commit 에서 쓰인다. 같은 Task 의 commit 은 직렬화되므로(2.2) 다음 commit 은 앞 commit 이 쓴 기록을 보고 센다. 발급하고 쓰지 않은 ID 는 소비되지 않는다 — commit 이 실패하거나 그 ID 로 쓰지 않으면 다음 commit 이 같은 번호를 다시 준다(Task ID 의 발급과 달리 연속이다). 3.2 의 유일성 검사가 `nextId` 를 쓰지 않은 호출자의 겹침도 막는다.
- **파일 구현체**: `nextId` 는 동기 함수다(`ChangeInput` 이 동기이므로). 그래서 함수 형태의 Change 를 받으면 함수를 부르기 전에, lock 을 쥔 상태에서 Task 디렉터리의 목록(`decisions/`, `feedback/`, `runs/`, `steps/*/{feedback,runs,gates}/`, `steps/*/artifacts/*/`)을 읽어 둔다. 기록 수십~수백 개의 목록이므로 비용은 작다.

### 3.5 commit 식별자 (5절 F12)

- **이름과 자리**: Event 의 `commit_id`. Event 스키마의 선택 필드다 — 옛 이벤트에는 없고 고칠 수 없다.
- **모양**: UUID 의 소문자 문자열(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`). 파일 구현체는 `crypto.randomUUID()`(버전 4, 난수 122비트)로 만든다. 여러 프로세스가 조율 없이 만들어도 겹치지 않고, 시각·호스트·경로를 담지 않는다. Store 는 시계를 읽지 않으므로(1절) 시각이 들어가는 형식(UUID v7, ULID)은 쓰지 않는다. 패턴은 버전을 고정하지 않아 DB 구현체가 자기 방식의 UUID 를 쓸 수 있다.
- **부여**: `commit()` 과 `createTask()` 의 호출마다 Store 가 하나를 만들어 그 commit 의 모든 이벤트에 같은 값을 넣는다. 구현체가 안에서 재시도해 `ChangeInput` 을 다시 부르더라도 한 호출의 값은 같아야 한다 — 재시도하는 구현은 식별자를 재시도 루프 밖에서 만든다(`src/store/types.ts` 의 `ChangeInput` 주석. 파일 구현체는 재시도하지 않고 lock 을 잡기 전에 만든다 — 3.11). 호출자는 주지 않는다 — `NewEvent` 에서 `commit_id` 를 뺐다. 타입을 우회해 이벤트에 `commit_id` 를 담아 보내면 `InvalidChangeError`.
- **보이는 곳**: `CommitResult.commitId`, `CommitOutcomeUnknownError.commitId`, 기록된 이벤트의 `commit_id`. `createTask` 의 반환 타입은 바꾸지 않는다(시그니처 유지) — 돌려주는 `events[].commit_id` 에 있다.
- **옛 이벤트와의 공존**: 확인하는 쪽은 언제나 자기 commit 의 새 식별자를 찾는다. 식별자가 없는 이벤트는 어떤 식별자와도 같지 않으므로 "내 것이 아니다" 로 읽히고, 따로 가르는 장치가 없다. 0단계의 운영 스크립트(append-events)는 `commit_id` 를 쓰지 않으므로 merge 뒤에도 그 스크립트가 쓴 이벤트는 식별자가 없다.
- **`.pending` 의 token 과의 관계**: 별개다. token 은 lock 획득마다의 난수로 파일 구현체 안의 개념이다(읽기가 잡는 lock 에도 있고 DB 구현체에는 없다). `commit_id` 는 인터페이스의 개념이다. `.pending-<token>/` 의 이름과 `commit.json` 의 모양은 그대로이고, `lines` 에 `commit_id` 가 들어 있으므로 2.5 의 내용 대조가 식별자까지 대조한다 — 같은 내용의 다른 commit 의 꼬리를 자기 것으로 오인할 여지가 줄어든다. 이벤트 줄의 필드 순서는 `seq`, `task_id`, `commit_id`, 나머지.
- 결과를 알 수 없는 commit 의 확인 절차는 `docs/design/commands.md` 3절.

### 3.6 Artifact 의 내용이 있는 곳 (5절 F9)

artifact 스키마에 두 필드와 조건을 더했다(T-0005 step-002). 스키마의 description 이 기준이고 여기는 요지다.

- `stored_in`: `store` | `repo`. `store` 면 내용은 Store 의 blob 이고 `content_key` 가 필수, `code`·`paths` 는 없어야 한다. `type` 은 `document` 나 `data`. `repo` 면 내용은 대상 repo 의 commit(`code`) 안의 파일이고 `code` 와 `paths`(repo 상대 경로, 1개 이상)가 필수, `content_key` 는 없어야 한다.
- `type: code_change` 는 언제나 repo 다 — `code` 필수, `content_key` 금지, `stored_in` 이 있으면 `repo`.
- `content_key` 에 blob 문법의 pattern 을 건다. **3.3 의 Store 의 key 문법**(`blob:<task>/[<step>/]<owner>.<name>` — owner 는 `R-NNN`, Step 수준이면 `G-NNN` 도, name 은 label 과 선택적인 ext)이고, step 스키마의 느슨한 `blob:<key>` 문법이 아니다(T-0005 step-002 에서 정했다). 이유: meta 가 가리키는 내용은 `getBlob` 으로 읽을 수 있어야 하는데 느슨한 문법은 `blob:key`, `blob:T-0001/step-001/R-002.yaml`(Run 기록 자체의 파일 이름) 같은 key 를 받는다. 기존 meta 의 key 는 모두 이 문법에 맞는다. 같은 pattern 을 `work_notes_key` 에도 건다(같은 종류의 key 다). 스키마가 확인하지 못하는 것: key 의 Task·Step 이 meta 의 `task_id`·`step_id` 와 같은지, 그 blob 이 실제로 있는지 — 문법에 맞는 key 는 `getBlob` 이 읽을 수 있는 자리를 가리키지만 없으면 `undefined` 다.
- `paths` 의 항목은 repo 상대 경로다: `/` 로 나뉜 비어 있지 않은 조각들이고, 조각에 역슬래시·`:`·제어 문자가 없으며 `.`·`..` 조각과 맨 앞의 `/` 가 없다(드라이브 문자, UNC, URL 이 여기서 막힌다). step 스키마의 `blob:` 조각 문법보다 넓다 — repo 의 파일 이름은 `.devflow.yaml` 처럼 점으로 시작하거나 공백을 담을 수 있다.
- **옛 기록**: `stored_in` 이 없으면 이 필드가 생기기 전의 기록이다. 그때는 `content_key` 와 `code` 중 **정확히 하나**가 있어야 하고(있는 쪽이 위치다) `paths` 는 없어야 한다. T-0001 의 `store-design`(document 인데 `code` 만 있다)을 비롯한 기존 meta 가 고치지 않은 채 통과한다 — `stored_in` 없이 쓰인 T-0001~T-0005 의 meta 전부이고, validate-data 가 데이터 repo 의 모든 meta 를 이 스키마로 검사한다(step-001 의 실험에서 34개, step-004 가 확인한 HEAD `6a438a8` 에서 40개). 새 meta 에는 `stored_in` 을 항상 적는다.
- 지금보다 느슨해지지 않는다: 지금 통과하는 모순(문서에 `content_key` 와 `code` 가 둘 다 있거나 둘 다 없는 것, `code_change` 에 `content_key`)이 새 스키마에서는 거부된다. 강제하지 못하는 것은 "새 meta 가 `stored_in` 을 빠뜨리는 것" 하나이고, 빠뜨려도 위의 옛 규칙 때문에 위치가 모호해지지는 않는다(repo 인 경우 `paths` 가 없을 뿐이다).

### 3.7 인터페이스에 더한 것

`src/store/types.ts`, `src/store/errors.ts`, `src/store/blob-ref.ts` 에 더한 선언의 요지다(주석은 줄였다 — 기준은 코드). 적지 않은 기존 선언은 그대로다.

```ts
import type { ArtifactVersion, Decision, Event, Feedback, GateResult, Run, Step, Task } from '../types/generated/index.js';

export interface EntityMap {
  task: Task;
  step: Step;
  decision: Decision;
  feedback: Feedback;
  gate_result: GateResult;
  run: Run;
  artifact: ArtifactVersion;
}

export interface EntityKeyMap {
  task: { taskId: string };
  step: { taskId: string; stepId: string };
  decision: { taskId: string; id: string };
  feedback: { taskId: string; id: string };              // 수준은 값의 step_id — Store 가 찾는다
  gate_result: { taskId: string; stepId: string; id: string };
  run: { taskId: string; id: string };                   // 수준은 값의 step_id — Store 가 찾는다
  artifact: { ref: string };                             // artifact://<task>/<step>/<name>@v<N>
}

export interface EntityScopeMap {
  task: { status?: Task['status'] };
  step: { taskId: string; status?: Step['status'] };
  decision: { taskId: string };
  /** stepId: 생략 = 두 수준 모두, null = Task 수준만, 문자열 = 그 Step 만. */
  feedback: { taskId: string; stepId?: string | null; kind?: Feedback['kind'] };
  gate_result: { taskId: string; stepId?: string };
  run: { taskId: string; stepId?: string | null; role?: Run['role'] };
  artifact: { taskId: string; stepId?: string; name?: string };
}

/** seq, task_id, commit_id 는 Store 가 부여한다. */
export type NewEvent = Omit<Event, 'seq' | 'task_id' | 'commit_id'>;

/** 'blob:' 으로 시작하는 blob 의 참조. 엔티티의 content_key, log_key 등에 그대로 담는다. */
export type BlobRef = `blob:${string}`;

/** blob 을 소유한 기록. key 의 모양이 여기서 정해진다(3.3). */
export type BlobOwner =
  | { taskId: string; stepId?: string; runId: string }
  | { taskId: string; stepId: string; gateId: string };

export interface BlobWrite {
  owner: BlobOwner;
  /** <label> 또는 <label>.<ext>. 예: 'work-notes', 'output.json', 'deterministic', 'transcript.jsonl'. */
  name: string;
  content: string | Uint8Array;
}

export interface Change {
  expectedLastSeq?: number;
  writes?: EntityWrite[];
  /** 이 commit 에 함께 기록할 blob. 이미 있는 key 면 AlreadyExistsError. */
  blobs?: BlobWrite[];
  events: [NewEvent, ...NewEvent[]];
}

/** ID 를 Store 가 발급하는 kind. Artifact 버전은 nextArtifactVersion. */
export type IssuedIdKind = 'step' | 'decision' | 'feedback' | 'gate_result' | 'run';

export interface CommitContext {
  lastSeq: number;
  /** 그 kind 의, Task 안에서 가장 큰 번호의 다음 ID ('R-008' 등). 같은 컨텍스트에서 부를 때마다 다음 번호. */
  nextId(kind: IssuedIdKind): string;
  /** 그 Step 의 그 이름의 다음 Artifact 버전(1부터). 같은 컨텍스트에서 부를 때마다 다음 번호. */
  nextArtifactVersion(stepId: string, name: string): number;
}

export interface CommitResult {
  events: Event[];
  /** 이 commit 의 식별자. events 의 commit_id 와 같다. */
  commitId: string;
}

export interface Store {
  // createTask, commit, get, list, readEvents — 시그니처 그대로
  /**
   * blob 하나를 읽는다. 없거나 key 가 문법에 맞지 않으면 undefined. commit 이 끝난 상태만 보인다.
   * @throws StoreBusyError, StoreUnavailableError
   */
  getBlob(ref: string): Promise<Uint8Array | undefined>;
}

// src/store/blob-ref.ts — 인터페이스 쪽의 순수 함수. 파일 위치를 모른다.
export declare function blobRef(owner: BlobOwner, name: string): BlobRef;

// src/store/errors.ts
/** 불변인 기록이 이미 있거나, Task 안의 ID 가 이미 쓰였거나, 대소문자만 다른 key·이름의 기록이 있다. 아무것도 기록되지 않았다. */
export declare class AlreadyExistsError extends StoreError {
  constructor(subject: string);
  readonly subject: string;
}
export declare class CommitOutcomeUnknownError extends StoreError {
  constructor(taskId: string, firstSeq: number, commitId: string, options?: ErrorOptions);
  readonly taskId: string;
  readonly firstSeq: number;
  /** 확인할 때 찾을 식별자 (commands.md 3절). */
  readonly commitId: string;
}
```

- `CommitOutcomeUnknownError` 의 생성자에 인자가 하나 늘지만 그것을 만드는 것은 Store 구현체뿐이고, 호출자는 잡아서 필드를 읽기만 한다.
- `get` 의 `artifact` key 에는 taskId 가 없다 — 구현체가 `ref` 에서 읽는다.
- `EntityWrite` 는 지금의 정의(`EntityMap` 에서 만들어지는 합)가 그대로 새 kind 를 받는다.

### 3.8 DB 구현체로의 대응 (더해지는 것)

| 인터페이스 | DB |
|---|---|
| kind 별 key | 테이블마다 기본 키 `(task_id, id)` (step 은 `(task_id, step_id)`, artifact 는 `(task_id, step_id, name, version)`). Run·Feedback 의 `step_id` 는 보통 열이다 |
| 불변 kind | insert 만 한다. 기본 키 위반을 `AlreadyExistsError` 로 옮긴다 |
| Task 안의 ID 유일성 | 기본 키가 `(task_id, id)` 이므로 수준과 무관하게 막힌다 |
| `nextId` | 행 lock 을 쥔 트랜잭션 안에서 `max(번호) + 1`. 동기 함수이므로 트랜잭션 시작 때 최댓값을 한꺼번에 읽어 둔다 |
| blob | object storage 나 blob 테이블. 트랜잭션 안에서 테이블에 쓰거나, object storage 라면 commit 전에 임시 이름으로 올리고 commit 뒤에 확정하는 두 단계가 된다 — 파일 구현체의 tmp → rename 과 같은 구조다 |
| `commit_id` | `events` 의 열. 확인은 `WHERE task_id = ? AND commit_id = ?` |

### 3.9 나중에 더할 길 (G-001 의 둘째·셋째 우려)

구현하지 않았다(T-0005 의 non_goals). 구현이 그 길을 막지 않는다는 것과 기존 시그니처를 깨지 않고 더하는 방법만 적는다.

- **Task 를 가로지르는 조회**: 지금 Task 밖의 kind 의 scope 는 모두 `taskId` 가 필수이고, 파일 구현체의 `list` 는 `taskId` 가 없거나 모양이 틀린 scope 에 빈 결과를 돌려준다. 나중에 `EntityScopeMap` 의 `taskId` 를 선택으로 바꾸면(타입을 넓히는 것) 기존 호출은 그대로 컴파일되고 같은 뜻을 가진다. 파일 구현체는 그 빈 결과의 자리에서 `list('task')` 처럼 Task 디렉터리마다 같은 절차를 되풀이하면 되고(Task 마다 따로 2.7 의 읽기 절차), DB 는 `WHERE task_id = ?` 를 빼면 된다. Run·Feedback 의 key 가 stepId 없이 Task 안의 ID 인 것도 이 길과 맞는다.
- **lock 안의 엔티티 읽기**: `CommitContext` 에 읽기 멤버(예: `get(kind, key)`)를 더하고 `ChangeInput` 의 함수가 `Promise<Change>` 도 돌려줄 수 있게 넓히면 된다. 둘 다 추가·확대이고 지금의 동기 함수를 넘기는 호출자는 그대로다. 지금 `CommitContext` 에는 읽기 멤버가 없고 `nextId`·`nextArtifactVersion` 은 동기다 — 비동기 함수 안에서도 동기 함수는 부를 수 있으므로 부딪치지 않는다. 파일 구현체는 함수를 부르기 전에 lock 안에서 Task 디렉터리의 기록 목록을 이미 읽으므로(2.4 의 2단계) 읽기 멤버는 그 목록으로 자리를 찾아 파일을 읽으면 된다.

### 3.10 여전히 범위 밖

- **`project` 등록부, 전역 설정**: Task 에 속하지 않으므로 별도의 작은 인터페이스로 둔다.
- **data repo 자동 commit**(ADR-0007): Store 의 책임이 아니라 commit 성공 후 호출되는 별도 구성 요소다. 파일 구현체 생성자에 `onCommitted(taskId, events)` 훅을 두면 된다.
- **Ledger**(`ledger.md`)를 Store 로 옮기는 것.
- 0단계의 운영 스크립트와 기록 방식을 Store 위로 옮기는 것.

### 3.11 구현에서 정한 것 (T-0005 step-003, step-004)

3.1~3.7 을 구현하며 설계가 말하지 않은 것을 정했다. 근거와 버린 대안은 그 Step 의 작업 노트에 있다.

- **규칙을 둔 곳.** blob key 의 문법은 `src/store/blob-ref.ts` 의 `parseBlobRef`(와 그것으로 만드는 `blobRef`) 하나이고, artifact 스키마의 `$defs/blobKey` pattern 과 같은 key 를 받는지는 `tests/store/blob-key.test.ts` 가 같은 key 목록으로 확인한다. 파일 이름 규칙 — 쓰기가 놓는 자리, `list` 가 kind 로 읽는 이름, `nextId` 가 세는 이름, blob key → 파일과 그 역 — 은 `src/store/file/layout.ts` 한 곳이다. `scripts/validate-data.mjs` 는 같은 이름 규칙을 따로 적고(스크립트는 빌드 없이 돈다), 둘이 같은 파일을 읽는지는 `tests/store/list-rules.test.ts` 가 같은 디렉터리에 둘을 대 보아 확인한다. `scripts/check-store-read.mjs` 도 기대값을 세려고 같은 규칙의 사본을 둔다(Store 의 `layout.ts` 로 세면 Store 가 자기 규칙으로 자기를 확인하게 된다) — 이 사본에는 list-rules 같은 대조 테스트가 없다. **규칙이 바뀔 때는 세 곳 — `layout.ts`, `validate-data.mjs`, `check-store-read.mjs` — 을 함께 고친다.** (Task·Step 디렉터리의 이름 규칙은 아직 validate-data 와 Store 가 다르다 — validate-data 는 `T-<숫자>` 와 `steps/` 의 모든 항목, Store 는 `T-<4자리 이상>` 과 `step-<숫자>` 만. 지금 기록에는 걸리는 이름이 없다. 맞추는 것은 후속 Task 의 몫이다.)
- **ID 의 모양은 쓸 때와 읽을 때가 다르다.** 쓸 때는 3.1 의 모양 그대로(3자리 0 채움, 999 를 넘으면 자릿수가 늘어난다 — `R-12`, `R-0012`, `R-000` 은 `InvalidChangeError`). 읽을 때(`list` 가 읽는 파일 이름, `get` 의 key)는 `<접두어>-<숫자>`(`R-\d+.yaml` 등, validate-data 와 같다)를 받는다 — 모양이 어긋난 파일을 조용히 건너뛰지 않고 읽어서, 스키마나 아래의 자리 확인에 걸리면 `invalid` 로 드러낸다. Step 디렉터리는 `step-<숫자>`. 모양이 맞지 않는 key 의 `get` 은 디스크를 보지 않고 `undefined` 다.
- **읽을 때 값이 그 자리의 것인지 확인한다.** 파일의 ID·`task_id`·`step_id`(수준)·Artifact 의 `ref` 가 그 파일의 자리와 다르면 `SchemaViolationError(read)`(`list` 에서는 `invalid`). 쓰기는 값으로 자리를 정하므로 Store 가 쓴 파일은 언제나 맞는다. 사람이 파일을 복사·이동한 경우를 드러내기 위한 것이다. 이 확인은 Task 에도 걸린다 — `task.yaml` 의 `id` 가 디렉터리 이름과 다르면 `get('task')` 는 `SchemaViolationError(read)`, `list('task')` 에서는 `invalid` 다. T-0005 전에는 통과하던 상태이므로 **기존 동작보다 조금 엄격해졌다**(사람이 Task 디렉터리를 복사해 이름을 바꾼 경우가 걸린다). 기존 기록 T-0001~T-0005 는 모두 맞는다.
- **한 Change 안에서** 같은 key 를 두 번 쓰는 것에 더해 같은 ID 를 다른 자리에 두 번 쓰는 것(예: Step 수준과 Task 수준의 R-005)도 `InvalidChangeError` 다(디스크와 부딪치는 것만 `AlreadyExistsError`). 알 수 없는 kind 도 `InvalidChangeError`.
- **Artifact 를 쓸 때 `content_key`·`work_notes_key` 를 확인한다.** key 의 Task·Step 이 meta 의 `task_id`·`step_id` 와 같고, 그 blob 이 같은 commit 의 `Change.blobs` 에 있거나 이미 있어야 한다(아니면 `InvalidChangeError`). 3.3 의 "없는 blob 을 가리키는 엔티티가 생기지 않는다" 를 불변인 Artifact 에 대해 지키려면 필요하다. 기존 meta 의 key 는 모두 같은 Step 의 blob 이다. `stored_in` 등 스키마가 요구하지 않는 필드는 더 요구하지 않는다.
- **`blobRef` 는 문법에 맞지 않는 소유자·이름을 `InvalidChangeError` 로 거부한다.** 조각에 `/` 나 `.` 이 섞여 다르게 나뉘는 key(예: taskId 에 Step 이 섞인 것)도 나눈 결과가 준 것과 다르므로 거부된다. `getBlob` 은 바이트(`Uint8Array` — 파일 구현체는 `Buffer`)를 돌려준다.
- **기록의 목록(3.4)은 함수 형태가 아닌 Change 에도 읽는다.** 3.2 의 덮어쓰기 방지와 ID 유일성 검사가 같은 목록(lock 을 쥔 뒤, 복구가 끝난 디스크)을 쓰기 때문이다. `nextId` 는 기록 파일과 blob 파일의 소유자 ID 를 같은 규칙(`layout.ts`)으로 센다. Step 번호는 `steps/` 아래에 파일이 있는 디렉터리 이름으로 센다(`step.yaml` 이 없어도).
- **commit 식별자는 lock 을 잡기 전에 호출마다 한 번 만든다.** 파일 구현체는 `ChangeInput` 의 함수를 한 호출에서 한 번만 부른다(재시도하지 않는다). 그러므로 "재시도에도 같은 값" 은 지금은 만드는 자리로만 보장된다. 나중에 재시도하는 구현(DB 구현체 등)은 식별자를 재시도 루프 밖에서 만든다(`ChangeInput` 의 주석).
- **대소문자만 다른 위치의 거부(3.2, 3.3)는 쓰기 계획(`file-store.ts` 의 `WritePlan`)이 한다.** 덮어쓰기 방지가 이미 쓰는 자리와 목록 — lock 을 쥔 뒤 읽은 Task 디렉터리의 목록, 같은 Change 에서 먼저 계획한 파일 — 에, 쓰려는 파일과 그 위의 디렉터리들을 대소문자를 접어서도 대 본다. 철자가 같으면 기존 규칙(불변이면 `AlreadyExistsError`, 가변이면 교체)이고, 철자가 대소문자만 다르면 디스크 쪽은 `AlreadyExistsError`, Change 쪽은 `InvalidChangeError` 다. 새 오류나 인터페이스 멤버는 없고 스키마(대문자를 받는 문법)도 그대로다. 파일 하나하나가 아니라 계획한 모든 파일에 걸리므로 blob 과 Artifact 이름 밖의 경우 — 사람이 둔 `g-002.yaml` 이 있는데 `G-002` 를 쓰는 것 — 도 같다. 비교는 ASCII 의 대소문자 접기(`toLowerCase`)다. Store 가 쓰는 이름은 모두 ASCII 라(스키마의 문법) 파일 시스템의 접기와 같다.
- **`nextArtifactVersion` 은 이름을 철자 그대로 센다.** `plan@v1` 이 있을 때 `nextArtifactVersion(step, 'Plan')` 은 1 이고, 그 버전을 쓰는 commit 은 위의 규칙으로 `AlreadyExistsError` 다. 접어서 세면 2 를 주지만 `Plan@v2` 도 같은 디렉터리라 거부되므로 얻는 것이 없고, `Plan` 을 `plan` 의 다음 버전처럼 보이게 한다. 거부는 쓰기 계획 한 곳에서 한다.
- **대소문자만 다른 key 로 읽으면 없는 것이다.** 대소문자를 가리지 않는 파일 시스템에서는 `Plan/v1.meta.yaml` 을 열면 `plan/v1.meta.yaml` 이 열린다. 그래서 `getBlob` 과 `get('artifact')` 는 읽기 전에 위치의 각 조각이 디렉터리의 항목과 한 글자도 다르지 않은지 보고(`storedAsSpelled`), 아니면 `undefined` 다 — 대소문자를 가리는 파일 시스템에서와 같은 결과다. 이것이 없으면 `getBlob('…R-001.notes')` 가 `R-001.Notes` 의 내용을 돌려준다. 비용은 읽기마다 디렉터리 목록 몇 번이다. 다른 kind 는 key 의 ID 가 정해진 대소문자(`R-`, `step-`)만 받거나 목록에서 자리를 찾으므로(Run·Feedback) 따로 보지 않는다.
- **뒷정리가 남은 commit 의 결과를 읽을 때**(2.4, 2.7 의 lock 경로) 새 kind 와 blob 도 `.pending` 의 tmp 에서 읽고, `list`·`get` 이 파일을 찾을 때 그 파일들도 있는 것으로 센다. tmp 가 이미 제자리로 옮겨졌으면 제자리의 파일을 읽는다.
- **AC7 의 확인**: `npm run check-store-read -- <data-dir>`(`scripts/check-store-read.mjs`). 데이터 디렉터리를 Store 로 열어 Task 마다 kind 마다 `list` 의 수와 `invalid` 를 validate-data 와 같은 이름 규칙으로 센 파일 수와 대 보고, runs/·gates/ 의 기록이 아닌 파일을 모두 `getBlob` 으로 읽어 내용을 비교한다. 파일을 쓰지 않는다. 검증용 스크립트이고 파일 구현체를 빌드 출력에서 직접 연다(`docs/architecture.md` 2절).

## 4. DB 구현체로의 대응

| 인터페이스 | DB |
|---|---|
| `createTask` | 시퀀스로 ID 발급 → 하나의 트랜잭션에서 `tasks` insert + `events` insert |
| `commit` | 트랜잭션: `SELECT last_seq FROM tasks WHERE id = ? FOR UPDATE` → `expectedLastSeq` 비교 → `events` insert(`(task_id, seq)` unique, `commit_id` 열) → 엔티티 upsert(불변 kind 는 insert 만) → blob 기록 → `last_seq` 갱신 |
| Task 별 직렬화 | 위의 행 lock. 파일 구현체의 lock 디렉터리에 해당 |
| 원자성·복구 | 트랜잭션. `.pending` 에 해당하는 것은 없다 |
| `ChangeInput` 함수 | 행 lock 획득 후 `CommitContext`(`lastSeq`, `nextId`, `nextArtifactVersion` — 3.8)로 호출. 직렬화 실패로 재시도하면 다시 호출될 수 있어 "동기·무부작용" 을 요구한다. commit 식별자는 재시도 루프 밖에서 호출마다 한 번 만든다 |
| `get` / `list` | 엔티티별 테이블(JSON 컬럼 + 필터용 컬럼) 조회. `invalid` 는 보통 비어 있다 |
| `getBlob` | blob 테이블 또는 object storage 에서 key 로 읽는다(3.8) |
| `readEvents` | `WHERE task_id = ? AND seq > ? ORDER BY seq` |
| commit 식별자 | `events.commit_id` 열. 결과를 알 수 없는 commit 의 확인은 `WHERE task_id = ? AND commit_id = ?` |
| `AlreadyExistsError` | 불변 kind·blob 의 기본 키 위반, Task 안의 ID 의 `(task_id, id)` 위반. 대소문자만 다른 key·이름도 파일 구현체와 같이 거부해야 하므로, key 를 대소문자를 구별해 비교하는 DB 라면 대소문자를 접은 값에 unique 제약을 둔다 |
| `StoreBusyError` | lock 대기 시간 초과 |
| `CommitOutcomeUnknownError` | COMMIT 도중 연결이 끊겨 성립 여부를 모르는 경우 |
| `StoreUnavailableError` | 연결 실패, 쿼리 실패 (트랜잭션은 롤백된 상태) |
| 2.7 의 읽기 절차, 2.8 의 한계 | 해당 없음. 트랜잭션 격리가 대신한다 |
| 이전 | Task 별로 `events.jsonl` 과 엔티티 파일을 읽어 같은 인터페이스의 DB 구현체에 넣는 스크립트. seq 는 그대로 보존 |

파일 구현체에만 있는 개념(`dataDir`, lock 디렉터리, `.pending`, YAML/JSONL, fsync)은 인터페이스에 나타나지 않는다. 오류의 `subject` 는 저장 위치가 아닌 식별자(`task T-0001`, `event T-0001#3`)다.

## 5. 발견한 스키마·배치의 과부족

| # | 발견 | 제안 |
|---|---|---|
| F1 | `task.target.task_branch` 가 Task ID 에 의존하는데 ID 는 Store 가 발급한다 | 스키마 변경 없음. `createTask(build)` 의 callback 으로 해결했다 |
| F2 | `Decision.next_step.step` 과 `step.yaml` 의 내용이 중복된다 | 둘 다 유지하되 의미를 스키마 description 에 명시: Decision 쪽은 **Planner 의 원래 제안(불변)**, Step 은 **사람 수정이 반영된 실효 정의**. 수정률을 회고에서 재려면 원본이 필요하다 |
| F3 | `step.inputs` 의 참조 형식이 정의되어 있지 않다 (`task.brief`, `code://devflow@<sha>` 는 관례로 썼다) | Context 패킷 resolver 를 만들 때 문법을 확정하고 pattern 으로 강제: `task.brief` \| `task.ledger` \| `artifact://…@vN` \| `code://<project>@<sha>` |
| F4 | Task 수준 Feedback(`requirement`, ask_human 에 대한 `answer`)은 `step_id` 가 없는데, 배치에는 `steps/<stepId>/feedback/` 만 있다 | `T-NNNN/feedback/` 을 추가(`devflow-data/README.md`) |
| F5 | `Event.data` 의 이벤트 종류별 내용이 정의되어 있지 않다 (`step.status_changed` 의 from/to 등) | Orchestrator 를 만들 때 종류별 payload 표를 정하고 스키마에 `if/then` 으로 추가. `task.created` 는 payload 가 필요 없어 이번 Task 에는 영향 없음 |
| F6 | `Event.actor` 형식이 description 에만 있고 강제되지 않는다 | **처리됨(T-0005 step-002)**: `schemas/event.schema.json` 의 `actor` 에 pattern `^(human:.+\|system\|role:(intake\|worker\|reviewer\|planner))$`. 옛 이벤트는 모두 맞는다. 테스트 `tests/schemas.artifact-event.test.ts` |
| F7 | Run 의 파일 위치가 README 에는 `runs/R-001.transcript.jsonl` 만 있고 Run 기록 자체의 위치가 없다. Step 에 속하지 않는 Run(Intake, Planner)의 위치도 없다 | `runs/<id>.yaml` 추가, Task 수준 `T-NNNN/runs/` 추가 |
| F8 | `.locks/`, `.pending-*/`, `.rollbacks` 가 `devflow-data/.gitignore` 에 없다 | `devflow-data` 는 T-0001 의 대상 repo 가 아니어서 후속 작업으로 남겼다. Store 를 실제 `devflow-data` 에 쓰기 전에 필요하다 |
| F9 | 대상 repo 안에 있는 문서 산출물(이 문서가 그 예)을 Artifact 로 어떻게 표현할지 모호하다. `type: document` 인데 내용은 `content_key` 가 아니라 `code`(commit 참조)로 가리켰다 | **처리됨(T-0005 step-002)**: artifact 스키마의 `stored_in: store \| repo` 와 `paths`(repo 상대 경로), 둘의 조건과 옛 기록용 규칙(3.6). `content_key`·`work_notes_key` 는 Store 의 blob key 문법. validate-data 가 meta 를 검사한다. Store 는 Artifact 를 쓸 때 key 의 Task·Step 과 blob 의 있음을 확인한다(3.11). 테스트 `tests/schemas.artifact-event.test.ts`, `tests/validate-data.test.ts` |
| F10 | `AGENTS.md` 7번과 `devflow-data/README.md` 의 "이벤트를 수정·삭제하지 않는다" 는 성립하지 않은 commit 의 잔여물을 잘라내는 복구(2.5)와 글자 그대로는 충돌한다 | `AGENTS.md` 7번은 고쳤다(ADR-0011). `devflow-data/README.md` 는 후속 작업으로 남겼다 |
| F11 | GateResult 의 `verdict` 가 pass/fail 뿐이라 "통과했지만 구현 전에 고쳐야 할 결함이 있다"(G-001 이 그랬다)를 표현하지 못한다. 사람이 comments 를 다 읽어야 알 수 있다 | `comments` 를 `{ severity: defect \| risk \| note, text }` 로 구조화하거나 verdict 에 `pass_with_concerns` 추가 |
| F12 | 이벤트에 commit(또는 호출자)의 식별자가 없다. `CommitOutcomeUnknownError` 뒤에 "내 변경이 들어갔는가" 를 내용 비교로만 확인할 수 있고, 두 호출자가 같은 내용의 이벤트를 만들면 구별할 수 없다 | **처리됨(스키마 T-0005 step-002, Store·commands step-003)**: Event 의 선택 필드 `commit_id`, Store 가 호출마다 부여(3.5), `CommitResult.commitId`·`CommitOutcomeUnknownError.commitId`, `confirmOutcome`·`createTask` 가 식별자로 판정(`docs/design/commands.md` 3절). 테스트 `tests/store/file-store.commit-id.test.ts`, `tests/commands/outcome.test.ts`, `tests/commands/create-task.test.ts` |

F9~F11 은 T-0001 의 설계 v1 에 대한 Gate(G-001), F12 는 v2 에 대한 Gate(G-002)와 검토 과정에서 나왔다.

F6, F9, F12 는 T-0005 에서 처리했다. F2 와 F5 는 남아 있다(F2 는 Decision 의 `human_edit` 과 함께, F5 는 Orchestrator 를 만들 때). F3 은 해당 구성 요소를 만들 때가 적기다. F4, F7, F8 은 `devflow-data` 의 문서·설정 변경이다.
