# State Store 설계

- 인터페이스: `src/store/types.ts`, 오류: `src/store/errors.ts`
- 대상: T-0001 (Task + 이벤트). 나머지 엔티티는 3절의 방식으로 추가한다.

## 0. 핵심 결정

| 결정 | 내용 |
|---|---|
| 기준 기록 | **이벤트 로그는 "무슨 일이 어떤 순서로 있었는가" 의 기준, 엔티티 문서는 "현재 내용" 의 기준.** 완전한 event sourcing(이벤트에서 엔티티를 재구성)은 하지 않는다. 이벤트는 엔티티 전체 내용을 담지 않고 참조만 한다 |
| 변경 단위 | `commit(taskId, change)` 하나가 엔티티 쓰기 N개 + 이벤트 1개 이상을 **원자적으로** 반영한다. 이벤트 없는 상태 변경은 없다 |
| 직렬화 범위 | Task 단위. 서로 다른 Task 의 commit 은 서로 기다리지 않는다 |
| 동시성 제어 | Task 별 배타적 접근 + 선택적 낙관적 검사(`expectedLastSeq`) |
| ID 발급 | Store 가 발급한다. 호출자는 발급된 ID 를 받아 엔티티를 만든다(`createTask(build)`) |
| 검증 | 쓰기 전 전부 검증(하나라도 위반하면 아무것도 기록 안 함), 읽을 때마다 검증 |
| 엔티티 접근 | `get(kind, key)` / `list(kind, scope)` 의 제네릭 형태. 엔티티 추가 시 시그니처가 바뀌지 않는다 |

완전한 event sourcing 을 택하지 않은 이유: 이벤트마다 엔티티 전체를 실어야 하고, 읽을 때마다 재구성(또는 스냅샷 관리)이 필요해 MVP 에 비해 과하다. 사람이 에디터로 `task.yaml` 을 바로 읽을 수 있다는 파일 구현체의 이점도 사라진다. 대신 "엔티티 쓰기와 이벤트 기록은 항상 같은 commit" 이라는 규칙으로 둘의 불일치를 막는다.

## 1. 메서드의 의미와 보장

### `createTask(build)`
- Store 가 새 Task ID(`T-NNNN`)를 발급하고 `build(taskId)` 를 호출해 Task 와 첫 이벤트(들)를 받는다. Task 와 이벤트를 하나의 commit 으로 기록한다. 첫 이벤트의 seq 는 1.
- ID 는 **유일하지만 연속은 아니다.** 기록에 실패하면 그 ID 는 버려질 수 있다.
- `build` 가 돌려준 `task.id` 가 발급된 ID 와 다르면 `InvalidChangeError`.
- `build` 는 동기·무부작용. (callback 인 이유: `target.task_branch` 처럼 ID 에 의존하는 필드가 있어 호출자가 ID 를 알아야 Task 를 완성할 수 있다.)
- 멱등 아님. 두 번 호출하면 Task 가 두 개 생긴다. 중복 방지는 호출자(commands)의 책임.

### `commit(taskId, change)`
- 원자성: writes 와 events 가 전부 반영되거나 전혀 반영되지 않는다. 프로세스가 중간에 죽어도 마찬가지다(2.5).
- 순서: 같은 Task 의 commit 은 직렬화된다. seq 는 1부터 빈틈없이 증가한다. 한 commit 의 이벤트들은 연속된 seq 를 받는다.
- `expectedLastSeq` 가 있으면 현재 마지막 seq 와 같을 때만 반영, 다르면 `ConflictError`. "v2 를 보고 누른 승인이 v3 에 적용되는 사고" 를 막는 수단이다(ADR-0004, ADR-0005). 생략하면 검사하지 않는다(마지막에 쓴 쪽이 이긴다).
- `change` 를 함수로 주면 배타적 접근을 얻은 뒤의 `lastSeq` 를 보고 Change 를 만들 수 있다. 함수는 동기·무부작용이고 여러 번 호출될 수 있다.
- 검증: 모든 writes 는 해당 엔티티 스키마로, 모든 events 는 seq/task_id 부여 후 event 스키마로 검증한다. writes 의 엔티티가 다른 Task 에 속하면 `InvalidChangeError`.
- 멱등 아님. 같은 Change 를 두 번 commit 하면 이벤트가 두 번 기록된다. 멱등성이 필요한 호출자(`advance`)는 `expectedLastSeq` 를 쓴다 — 두 번째 호출은 `ConflictError` 가 된다.
- 오류: `TaskNotFoundError`, `ConflictError`, `SchemaViolationError(write)`, `InvalidChangeError`, `StoreBusyError`. **`CommitOutcomeUnknownError` 가 아닌 모든 오류는 — 여기 나열되지 않은 I/O 오류까지 포함해 — 아무것도 기록되지 않았음을 뜻한다.** 이것이 인터페이스의 계약이고 `createTask` 에도 똑같이 적용된다.
- 결과를 알 수 없는 경우: 기록 도중 I/O 오류가 났고 성립 여부를 그 자리에서 판정하지 못하면 `CommitOutcomeUnknownError` 를 던진다. 호출자는 `readEvents` 로 성립 여부를 확인해야 한다. 어느 쪽으로든 Store 의 상태는 다음 접근에서 일관되게 복구된다. (DB 구현체에서는 COMMIT 도중 연결이 끊긴 경우에 해당한다.)
- commit 이 성립한 뒤의 뒷정리 실패는 오류가 아니다. `commit()` 은 성공을 돌려주고 뒷정리는 다음 접근이 마친다(2.4, 2.5).

### `get(kind, key)` / `list(kind, scope)`
- 끝난 commit 의 결과만 보인다. 반쯤 반영된 상태는 보이지 않는다. 파일 구현체가 이를 어떻게 보장하는지는 2.7.
- `get`: 없으면 `undefined`, 있는데 스키마 위반이면 `SchemaViolationError(read)`.
- `list`: 읽지 못한 항목은 `invalid` 에 담아 돌려주고 나머지는 정상 반환한다. Task 하나가 손상되었다고 `task status` 전체가 실패하면 안 되기 때문이다.
- 읽기도 `StoreBusyError` 를 던질 수 있다. 진행 중인 commit 이 끝나기를 기다리다 제한 시간을 넘긴 경우다(`readEvents` 도 같다).
- 스냅샷 일관성은 엔티티 하나 단위다. `list` 도중 다른 Task 가 바뀔 수 있다.

### `readEvents(taskId, { afterSeq })`
- seq 순. `afterSeq` 로 증분 읽기. 없는 Task 면 `TaskNotFoundError`.
- 한 commit 의 이벤트는 전부 보이거나 전혀 보이지 않는다.
- 읽을 때 seq 가 1부터 빈틈없이 증가하는지 확인한다. 중복이나 빈틈이 있으면 `SchemaViolationError(read)` 다. lock 이 깨지는 드문 경우(2.8)를 조용히 넘기지 않고 드러내기 위한 방어선이다.

### 이벤트의 `at`
호출자(commands)가 정한다. Store 는 시계를 읽지 않는다(테스트 용이성). 순서의 기준은 `at` 이 아니라 `seq` 다.

## 2. 파일 구현체 설계

### 2.1 배치 (`devflow-data/README.md` 와 동일)

```
<dataDir>/
  .locks/T-0001.lock/owner.json     # Task 별 lock. 회수 전용 lock 은 T-0001.reap (git 에 넣지 않음)
  T-0001/
    task.yaml                        # 엔티티 'task'
    events.jsonl                     # 한 줄에 이벤트 하나, LF
    .pending-<token>/commit.json     # 진행 중인 commit 의 기록 (정상 시에는 없음, git 에 넣지 않음)
```

- 엔티티는 YAML, 이벤트는 JSON Lines. 줄바꿈은 항상 LF, 인코딩은 UTF-8.
- `dataDir` 은 구현체 생성자 인자다. 인터페이스에는 나타나지 않는다.
- "Task 가 존재한다" 의 정의: `events.jsonl` 에 seq 1 이 있다. 디렉터리만 있고 이벤트가 없는 것은 버려진 ID 다.
- `.locks/` 와 `.pending-*/` 을 `devflow-data/.gitignore` 에 추가해야 한다(구현 Step 에서).

### 2.2 Lock

원칙: **살아 있는 프로세스의 lock 은 절대 빼앗지 않는다.** 판단이 틀렸을 때 "기록이 조용히 깨지는" 쪽이 아니라 "Task 가 시끄럽게 잠기는" 쪽으로 틀리게 한다. (v2 의 시간 기준 회수는 멈췄다 깨어난 소유자가 새 소유자의 상태를 망가뜨릴 수 있어 폐기했다. `maxHold`, 소유자의 자진 포기, 시계에 의존하는 규칙은 모두 없앴다.)

**획득**
- lock 은 디렉터리 `<dataDir>/.locks/<taskId>.lock` 이고 그 안에 `owner.json` = `{ pid, hostname, platform, token, acquiredAt }` 이 있다. `token` 은 획득마다 새로 만든 난수, `acquiredAt` 은 사람이 읽기 위한 정보일 뿐 판정에 쓰지 않는다.
- **lock 디렉터리는 항상 `owner.json` 과 함께 나타난다**: 임시 디렉터리(`.locks/.tmp-<token>/`)에 `owner.json` 을 먼저 쓴 뒤 lock 경로로 `rename` 한다. 대상이 이미 있으면(비어 있지 않은 디렉터리) rename 이 실패하고, 그것이 "남이 쥐고 있다" 는 신호다. `mkdir` 후에 `owner.json` 을 쓰는 방식은 그 사이에 죽으면 주인 없는 lock 이 남아 시간으로 판정할 수밖에 없어 쓰지 않는다.
- 획득 실패 시 짧은 간격(10~50ms, 지터)으로 재시도하고 제한 시간(기본 5초)을 넘으면 `StoreBusyError`. 임계 구역은 밀리초 단위다.
- OS 의 파일 lock API 는 플랫폼마다 달라 쓰지 않는다.

**해제**: lock 디렉터리를 고유한 이름(`.locks/.tmp-<token>-released/`)으로 `rename` 한 뒤 삭제한다. 살아 있는 lock 을 남이 없애는 경로가 없으므로 경로에 있는 것은 항상 자신의 lock 이다. 경로에서 바로 삭제하지 않는 이유: `owner.json` 을 지운 뒤 디렉터리를 지우기 전의 "빈 lock 디렉터리" 가 보이면 안 되기 때문이다(POSIX 에서는 빈 디렉터리 위로의 rename 이 성공해, 뒤따르는 삭제가 새 소유자의 lock 을 지울 수 있다). 회수(아래 4단계)의 삭제도 같은 방식으로 한다.

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
- 회수자가 2~5 사이에 죽으면 `.reap` 이 남는다(crash 복구 도중의 crash). `.reap` 은 자동 회수하지 않는다 — 같은 문제가 한 단계 위에서 되풀이될 뿐이다. 남은 `.reap` 은 stale lock 의 회수만 막고, 그 결과는 `StoreBusyError` 와 수동 삭제 안내다.
- Windows 에서 다른 프로세스가 `owner.json` 을 열고 있는 순간에는 디렉터리 삭제·rename 이 `EPERM`/`EBUSY` 로 실패할 수 있다. 짧게 재시도한다.
- 읽기는 lock 을 잡지 않고 시작한다(2.7).

### 2.3 Task ID 발급

- 전역 lock 을 쓰지 않는다. 현재 최대 `T-NNNN` + 1 을 후보로 `mkdir <dataDir>/T-NNNN` 을 시도하고, `EEXIST` 면 +1 해서 다시 시도한다. `mkdir` 의 원자성이 유일성을 보장한다.
- 그 뒤 해당 Task 의 lock 을 잡고 일반 commit 과 같은 절차로 Task 와 첫 이벤트를 기록한다.
- ADR-0008 결정 4 와 `architecture.md` 는 "Task ID 발급을 lock 으로 직렬화한다" 고 적고 있다. 이 설계는 같은 목적(유일성)을 lock 없이 달성한다. 문서를 맞추는 일은 이 Step 의 범위 밖이다.
- 4자리 0 채움, 9999 를 넘으면 자릿수가 늘어난다(스키마 패턴 `^T-[0-9]{4,}$`).

### 2.4 commit 절차

lock 을 잡은 상태에서:

1. `.pending-*/` 이 있으면 복구한다(2.5).
2. `events.jsonl` 의 마지막 줄에서 `lastSeq` 를 읽는다. `change` 가 함수면 `{ lastSeq }` 로 호출한다.
3. `expectedLastSeq` 검사 → `ConflictError`.
4. writes 와, seq/task_id 를 부여한 events 를 전부 스키마 검증 → `SchemaViolationError`. **여기까지는 디스크를 건드리지 않는다.**
5. `.pending-<token>/` 을 만든다(`token` 은 자신의 lock token). 각 write 를 그 안의 `<n>.tmp` 에 쓰고 fsync. 마지막으로 `commit.json` 을 쓰고 fsync:
   `{ token, firstSeq, lines: [기록할 이벤트 줄 그대로], files: [{ tmp, final }] }` (final 은 Task 디렉터리 기준 상대 경로)
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

`.pending-*/` 이 남아 있으면 이전 commit 이 중간에 죽었거나 뒷정리를 마치지 못한 것이다. lock 을 잡은 프로세스가 **내용을 대조해** 판정한다. `events.jsonl` 에서 seq 가 `firstSeq` 이상인 부분(이하 "꼬리")을 `commit.json` 의 `lines` 와 비교한다.

| 꼬리의 상태 | 판정 | 처리 |
|---|---|---|
| `lines` 전체와 정확히 같다 | 성립했다 | **앞으로 굴린다**: 남은 tmp 를 final 로 rename(이미 옮겨진 것은 건너뜀), `.pending-*/` 삭제 |
| 비어 있다, 또는 `lines` 를 이어 붙인 것의 앞부분이다(마지막 줄이 중간에 잘린 경우 포함) | 성립하지 않았다 | **되돌린다**: 꼬리를 잘라내고 `.pending-*/` 삭제 |
| `commit.json` 이 없거나 읽히지 않는다 | 5단계 도중 죽었다. 이벤트는 기록되지 않았다 | `.pending-*/` 삭제 |
| 그 밖의 모든 경우 — 꼬리에 `lines` 와 다른 내용이 있다, `lines` 뒤에 줄이 더 있다, `.pending-*/` 이 둘 이상이다 | **판정하지 않는다** | 아무것도 건드리지 않고 `SchemaViolationError(read)` 를 던진다. 메시지에 Task 와 `.pending-*/` 의 위치를 담는다. 사람이 확인해야 한다 |

- 되돌리기가 잘라내는 것은 **자신의 `lines` 와 일치하는 바이트뿐**이다. 다른 프로세스가 성립시킨 이벤트를 지우는 일은 없다(v2 의 "`firstSeq` 이상의 줄을 센다" 는 방식은 이를 구별하지 못했다).
- 마지막 경우는 설계상 생기지 않는다. 생겼다면 lock 의 가정이 깨진 것이므로(2.8) 자동으로 고치지 않는다. 그 Task 에 대한 이후의 쓰기와 lock 경로의 읽기는 사람이 정리할 때까지 같은 오류를 낸다.
- 복구는 몇 번을 수행해도 결과가 같다. 복구 도중에 죽으면 다음 접근이 같은 복구를 처음부터 다시 한다. 복구는 lock 을 쥔 프로세스만 수행한다.
- "append-only" 는 **성립한 commit 의 이벤트**에 대한 규칙이다. 성립하지 않은 commit 의 잔여물을 잘라내는 것은 위반이 아니다. `AGENTS.md` 7번과 `devflow-data/README.md` 의 문구는 이 해석을 담고 있지 않다(5절 F10).

### 2.6 검증 시점

- 쓰기: 2.4 의 4단계. `ajv`(draft 2020-12) + `ajv-formats`. 스키마는 시작 시 한 번 컴파일한다.
- 읽기: 파싱 직후 매번. 사람이 파일을 손으로 고칠 수 있는 0~1단계에서는 특히 필요하다. 성능이 문제가 되면 (mtime, size) 기준 캐시를 구현체 내부에 둘 수 있다.

### 2.7 읽기 절차

reader 는 lock 없이 시작하되, commit 과 겹쳤을 가능성이 있으면 결과를 버린다. (v1 의 "`.pending` 이 안 보이면 그냥 읽는다" 는 확인과 읽기 사이에 commit 이 시작될 수 있어 틀렸다.)

표식은 두 가지다: **S** = `events.jsonl` 의 크기와 mtime(파일이 없으면 "없음"), **P** = `.pending-*/` 의 존재 여부.

1. 앞 표식을 **S, P 순서로** 읽는다.
2. 대상을 읽는다(`task.yaml`, 또는 `events.jsonl` 전체).
3. 뒤 표식을 **P, S 순서로** 읽는다.
4. 앞뒤 모두 P 가 없고 S 가 같으면 읽은 내용을 쓴다.
5. 아니면 짧은 백오프로 1부터 다시 한다(최대 3회). 그래도 안 되면 **lock 을 잡고** 읽는다. lock 을 잡으면 commit 이 끝나기를 기다린 셈이고, 죽은 commit 이 있었다면 복구(2.5)를 수행한 뒤 읽게 된다.

앞뒤 모두 S 가 "없음" 이고 P 가 없으면 그 Task 는 존재하지 않는다(버려진 ID 이거나 `createTask` 가 아직 5단계에 이르지 않았다). `get` 은 `undefined`, `list` 는 건너뜀, `readEvents` 는 `TaskNotFoundError` 다. 재시도하지 않는다.

왜 충분한가: 읽는 순서 때문에 시각은 S앞 < P앞 < 읽기 < P뒤 < S뒤 다. 어떤 commit 의 `.pending` 구간(5단계에서 생겨 7단계 끝에 사라진다)이 읽기와 겹쳤는데 P앞 과 P뒤 가 모두 "없음" 이었다면, 그 구간 전체가 P앞 과 P뒤 사이에 들어 있다. 그러면 그 commit 의 6단계(append)도 S앞 과 S뒤 사이에 있으므로 S 가 달라진다. append 후 죽고 다른 프로세스가 되돌려 크기가 원래대로 돌아온 경우는 mtime 이 잡는다. 따라서 4를 통과한 읽기는 어떤 commit 과도 겹치지 않았다. 잘린 줄, 나중에 되돌려질 이벤트, 한 commit 의 이벤트 일부, 이벤트는 있는데 엔티티는 옛것인 상태 중 어느 것도 보이지 않는다.

- 2에서 파일이 rename 되는 중이라 `EPERM`/`EBUSY`/`ENOENT` 가 나면 겹친 것으로 보고 5로 간다.
- `list` 는 Task 마다 이 절차를 따로 수행한다.
- 읽기 전용 매체(또는 쓰기 권한이 없는 사용자)에서는 5의 lock 경로를 쓸 수 없다. 이 경우 `StoreBusyError` 다. 읽기 전용 소비자는 지원 대상이 아니다.

### 2.8 한계

- **전원 장애에 대한 내구성은 보장하지 않는다.** 보장하는 것은 프로세스 crash 에 대한 원자성이다. Windows 에서는 디렉터리 fsync 가 불가능해 rename 과 삭제의 내구성이 NTFS 저널에 달려 있다. `devflow-data` 가 git repo 이고 Step 전이마다 commit 되므로(ADR-0007) 최악의 경우 마지막 git commit 으로 돌아갈 수 있다.
- **한 호스트, 한 플랫폼에서만 쓴다.** 여러 호스트가 같은 `dataDir`(공유 폴더, 네트워크 드라이브)을 쓰거나 Windows 와 WSL 이 같은 `dataDir` 을 함께 쓰는 것은 지원하지 않는다. 서로의 lock 을 빼앗지는 않지만(2.2), 상대가 죽으며 남긴 lock 은 수동으로 지워야 한다. 여러 호스트가 필요해지는 시점이 DB 구현체로 넘어갈 시점이다(roadmap 4단계).
- **사람이 lock 을 지워야 하는 경우가 있다**: 죽은 소유자의 pid 가 재사용된 경우, 회수 도중 죽어 `.reap` 이 남은 경우. 둘 다 `StoreBusyError` 의 메시지가 안내한다.
- **두 프로세스가 동시에 lock 을 쥐게 되는 경로는 설계상 없다.** 남는 것은 설계 밖의 경로다: 사람이 살아 있는 프로세스의 lock 을 지운 경우, hostname 과 platform 이 같은데 pid 공간이 다른 환경(같은 호스트의 컨테이너가 hostname 을 공유하도록 설정된 경우 등). 이때의 방어선은 세 겹이다 — token 이 들어간 `.pending`(서로의 메모를 덮어쓰지 않는다), 내용을 대조하는 복구(남의 이벤트를 자르거나 확정하지 않고 오류로 멈춘다), `readEvents` 의 seq 연속성 검사. 이 방어선은 피해를 **드러내는** 것이지 막는 것이 아니다.

### 2.9 구현 Step 에서 확정·확인할 것

설계로는 정했으나 실측이나 테스트가 필요한 것, 그리고 구현하면서 정하면 되는 것이다.

| # | 항목 |
|---|---|
| I1 | Windows(NTFS)에서 비어 있지 않은 디렉터리 위로의 디렉터리 `rename` 이 실패하는지, 어떤 오류 코드인지(2.2 획득의 전제). 성립하지 않으면 대안을 설계 노트에 반영한다 |
| I2 | append 와 잘라내기 직후 `fs.stat` 이 바뀐 크기와 mtime 을 즉시 돌려주는지(2.7 의 전제). NTFS 의 mtime 해상도 안에서 "append 후 되돌리기" 가 같은 mtime 을 남길 수 있는지. 믿을 수 없다면 Task 별 commit 카운터 파일로 S 를 대체한다 |
| I3 | 단계별 실패(2.4 의 표)와 복구(2.5 의 표)의 각 경우를 재현하는 테스트 방법 — 파일 시스템 호출에 장애를 주입할 수 있는 구조 |
| I4 | 동시성 테스트: 여러 프로세스(스레드가 아니라)가 같은 Task 에 commit, 동시에 `createTask` (AC3, AC4) |
| I5 | 재시도 간격, 제한 시간, rename 재시도 횟수의 기본값과 설정 방법 |
| I6 | `CommitOutcomeUnknownError` 를 받은 호출자의 확인 규약: `readEvents({ afterSeq: firstSeq - 1 })` 의 결과가 자신이 보낸 이벤트와 내용이 같으면 성립. commands 계층의 규약으로 문서화한다. 이벤트에 commit 식별자가 없어 내용 비교에 의존한다는 점은 5절 F12 |
| I7 | `StoreBusyError` 메시지의 안내 문구(무엇을 확인하고 무엇을 지우는지) |

## 3. 나머지 엔티티의 추가

`EntityMap` / `EntityKeyMap` / `EntityScopeMap` 에 항목을 추가하고, 파일 구현체에 "kind → 파일 위치·스키마" 매핑을 추가한다. `Store` 의 메서드는 바뀌지 않는다.

| kind | key | scope (list) | 파일 위치 |
|---|---|---|---|
| `step` | `{ taskId, stepId }` | `{ taskId, status? }` | `steps/<stepId>/step.yaml` |
| `decision` | `{ taskId, id }` | `{ taskId }` | `decisions/<id>.yaml` |
| `feedback` | `{ taskId, id }` | `{ taskId, stepId?, kind? }` | `steps/<stepId>/feedback/<id>.yaml` 또는 Task 수준(5절 F4) |
| `gate_result` | `{ taskId, stepId, id }` | `{ taskId, stepId }` | `steps/<stepId>/gates/<id>.yaml` |
| `run` | `{ taskId, id }` | `{ taskId, stepId?, role? }` | `steps/<stepId>/runs/<id>.yaml` |
| `artifact` | `{ ref }` (`artifact://…@vN`) | `{ taskId, stepId, name? }` | `steps/<stepId>/artifacts/<name>/v<N>.meta.yaml` |

추가로 필요해질 것(이번 범위 밖, 모두 **추가**이지 변경이 아니다):

- **Task 내부 ID 발급** (`D-001`, `F-001`, `G-001`, `R-001`, Artifact 버전): `CommitContext` 에 `nextId(kind)` 를 추가한다. commit 의 함수 형태를 지금 둔 이유다.
- **내용물(blob)**: 문서 산출물 본문, transcript, 검증 로그. 스키마의 `content_key` / `transcript_key` / `log_key` 가 가리키는 대상이다. `putBlob(taskId, content) → key`, `getBlob(key)` 를 추가하고, blob 은 불변이므로 commit 밖에서 먼저 쓰고 그 key 를 엔티티에 담아 commit 한다(참조되지 않는 blob 은 무해한 쓰레기다).
- **`project` 등록부, 전역 설정**: Task 에 속하지 않으므로 별도의 작은 인터페이스로 둔다.
- **data repo 자동 commit**(ADR-0007): Store 의 책임이 아니라 commit 성공 후 호출되는 별도 구성 요소다. 파일 구현체 생성자에 `onCommitted(taskId, events)` 훅을 두면 된다.

## 4. DB 구현체로의 대응

| 인터페이스 | DB |
|---|---|
| `createTask` | 시퀀스로 ID 발급 → 하나의 트랜잭션에서 `tasks` insert + `events` insert |
| `commit` | 트랜잭션: `SELECT last_seq FROM tasks WHERE id = ? FOR UPDATE` → `expectedLastSeq` 비교 → `events` insert(`(task_id, seq)` unique) → 엔티티 upsert → `last_seq` 갱신 |
| Task 별 직렬화 | 위의 행 lock. 파일 구현체의 lock 디렉터리에 해당 |
| 원자성·복구 | 트랜잭션. `.pending` 에 해당하는 것은 없다 |
| `ChangeInput` 함수 | 행 lock 획득 후 호출. 직렬화 실패로 재시도하면 다시 호출될 수 있어 "동기·무부작용" 을 요구한다 |
| `get` / `list` | 엔티티별 테이블(JSON 컬럼 + 필터용 컬럼) 조회. `invalid` 는 보통 비어 있다 |
| `readEvents` | `WHERE task_id = ? AND seq > ? ORDER BY seq` |
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
| F6 | `Event.actor` 형식이 description 에만 있고 강제되지 않는다 | pattern 추가: `^(human:.+\|system\|role:(intake\|worker\|reviewer\|planner))$` |
| F7 | Run 의 파일 위치가 README 에는 `runs/R-001.transcript.jsonl` 만 있고 Run 기록 자체의 위치가 없다. Step 에 속하지 않는 Run(Intake, Planner)의 위치도 없다 | `runs/<id>.yaml` 추가, Task 수준 `T-NNNN/runs/` 추가 |
| F8 | `.locks/`, `.pending-*/` 이 `devflow-data/.gitignore` 에 없다 | 구현 Step 에서 추가 |
| F9 | 대상 repo 안에 있는 문서 산출물(이 문서가 그 예)을 Artifact 로 어떻게 표현할지 모호하다. `type: document` 인데 내용은 `content_key` 가 아니라 `code`(commit 참조)로 가리켰다 | Artifact 에 "내용의 위치" 를 명시하는 필드(`stored_in: store \| repo`)와 repo 내 경로 목록을 추가 |
| F10 | `AGENTS.md` 7번과 `devflow-data/README.md` 의 "이벤트를 수정·삭제하지 않는다" 는 성립하지 않은 commit 의 잔여물을 잘라내는 복구(2.5)와 글자 그대로는 충돌한다 | 두 문서의 문구를 "성립한 commit 의 이벤트" 로 고친다 |
| F11 | GateResult 의 `verdict` 가 pass/fail 뿐이라 "통과했지만 구현 전에 고쳐야 할 결함이 있다"(G-001 이 그랬다)를 표현하지 못한다. 사람이 comments 를 다 읽어야 알 수 있다 | `comments` 를 `{ severity: defect \| risk \| note, text }` 로 구조화하거나 verdict 에 `pass_with_concerns` 추가 |
| F12 | 이벤트에 commit(또는 호출자)의 식별자가 없다. `CommitOutcomeUnknownError` 뒤에 "내 변경이 들어갔는가" 를 내용 비교로만 확인할 수 있고, 두 호출자가 같은 내용의 이벤트를 만들면 구별할 수 없다 | Event 에 선택 필드 `commit_id`(Store 가 commit 마다 부여)를 추가하고 `CommitResult` 와 오류에 담는다 |

F9~F11 은 v1 에 대한 Gate(G-001), F12 는 v2 에 대한 Gate(G-002)와 검토 과정에서 나왔다.

F2, F6 은 작은 스키마 변경이고 이번 Task 의 AC 와 무관하다. 이번 Task 에서 할지는 Planner 가 판단한다. F3, F5 는 해당 구성 요소를 만들 때가 적기다. F4, F7, F8 은 `devflow-data` 의 문서·설정 변경이다.
