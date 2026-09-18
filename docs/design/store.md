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
- 오류: `TaskNotFoundError`, `ConflictError`, `SchemaViolationError(write)`, `InvalidChangeError`, `StoreBusyError`. 이 오류들은 모두 **아무것도 기록되지 않았음**을 뜻한다.
- 결과를 알 수 없는 경우: 기록 도중 I/O 오류가 났고 성립 여부를 그 자리에서 판정하지 못하면 `CommitOutcomeUnknownError` 를 던진다. 호출자는 `readEvents` 로 성립 여부를 확인해야 한다. 어느 쪽으로든 Store 의 상태는 다음 접근에서 일관되게 복구된다. (DB 구현체에서는 COMMIT 도중 연결이 끊긴 경우에 해당한다.)
- commit 이 성립한 뒤의 뒷정리 실패는 오류가 아니다. `commit()` 은 성공을 돌려주고 뒷정리는 다음 접근이 마친다(2.4, 2.5).

### `get(kind, key)` / `list(kind, scope)`
- 끝난 commit 의 결과만 보인다. 반쯤 반영된 상태는 보이지 않는다. 파일 구현체가 이를 어떻게 보장하는지는 2.7.
- `get`: 없으면 `undefined`, 있는데 스키마 위반이면 `SchemaViolationError(read)`.
- `list`: 읽지 못한 항목은 `invalid` 에 담아 돌려주고 나머지는 정상 반환한다. Task 하나가 손상되었다고 `task status` 전체가 실패하면 안 되기 때문이다.
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
  .locks/T-0001.lock/owner.json     # Task 별 lock (git 에 넣지 않음)
  T-0001/
    task.yaml                        # 엔티티 'task'
    events.jsonl                     # 한 줄에 이벤트 하나, LF
    .pending/commit.json             # 진행 중인 commit 의 기록 (정상 시에는 없음, git 에 넣지 않음)
```

- 엔티티는 YAML, 이벤트는 JSON Lines. 줄바꿈은 항상 LF, 인코딩은 UTF-8.
- `dataDir` 은 구현체 생성자 인자다. 인터페이스에는 나타나지 않는다.
- "Task 가 존재한다" 의 정의: `events.jsonl` 에 seq 1 이 있다. 디렉터리만 있고 이벤트가 없는 것은 버려진 ID 다.
- `.locks/` 와 `.pending/` 을 `devflow-data/.gitignore` 에 추가해야 한다(구현 Step 에서).

### 2.2 Lock

- **디렉터리 생성을 lock 으로 쓴다**: `mkdir <dataDir>/.locks/<taskId>.lock`. `mkdir` 은 NTFS 를 포함해 모든 플랫폼에서 원자적이고 이미 있으면 `EEXIST` 로 실패한다. OS 의 파일 lock API 는 플랫폼마다 달라 쓰지 않는다.
- 획득 후 `owner.json` 에 `{ pid, hostname, token, acquiredAt }` 를 쓴다.
- 획득 실패 시 짧은 간격(10~50ms, 지터)으로 재시도, 제한 시간(기본 5초)을 넘으면 `StoreBusyError`. Store 의 임계 구역은 밀리초 단위라 정상 상황에서는 충분하다.
- 해제: `owner.json` 의 token 이 자신의 것인지 확인 후 디렉터리 삭제.
- 읽기는 lock 을 잡지 않고 시작한다(2.7).

**stale 판정.** 다음 중 하나면 그 lock 은 stale 이다.

| 조건 | 의미 |
|---|---|
| `owner.json` 의 pid 가 살아 있지 않다 (`process.kill(pid, 0)` 이 `ESRCH`) | 소유자가 죽었다. `EPERM` 은 "살아 있음" 이다 |
| `acquiredAt` 이 `staleAfter`(기본 60초)보다 오래되었다 — pid 생존 여부와 무관 | pid 가 재사용되었거나 소유자가 멈췄다 |
| `owner.json` 이 없고 lock 디렉터리의 mtime 이 `staleAfter` 보다 오래되었다 | `owner.json` 을 쓰기 전에 죽었다 |

- 두 번째 조건이 pid 재사용에 대한 답이다. Windows 는 pid 를 빠르게 재사용하므로 pid 생존만 보면 죽은 소유자의 lock 이 영구히 남을 수 있다. 다른 프로세스의 시작 시각을 얻는 이식성 있는 방법이 Node 에 없어 시간 기준을 택했다.
- 시간 기준으로 살아 있는 소유자의 lock 을 빼앗지 않도록 **소유자가 스스로 물러난다**: 소유자는 commit 시점(2.4 의 6단계) 직전에 (a) lock 을 잡은 지 `maxHold`(기본 10초)가 지나지 않았는지, (b) `owner.json` 의 token 이 여전히 자신의 것인지 확인한다. 하나라도 아니면 아무것도 기록하지 않고 `StoreBusyError` 를 던진다. 정상적인 임계 구역은 밀리초 단위이므로 `maxHold` 에 걸리는 것은 프로세스가 멈췄던 경우(디버거, 절전)뿐이다. `maxHold` 와 `staleAfter` 사이의 50초가 안전 여유다.
- `owner.json` 의 hostname 이 자신과 다르면 빼앗지 않고 `StoreBusyError` 를 던진다. 여러 호스트가 같은 `dataDir` 을 쓰는 것은 지원하지 않는다(2.8).

**회수 절차.** stale lock 을 없애는 것은 회수 전용 lock 을 쥔 프로세스만 한다. (v1 의 "rename 은 한 프로세스만 성공한다" 는 틀렸다 — 나중에 도착한 rename 이 먼저 회수한 쪽의 새 lock 을 옮길 수 있다.)

1. 대상 lock 의 token 을 기억해 둔다(`owner.json` 이 없으면 "없음" 을 기억).
2. `mkdir <dataDir>/.locks/<taskId>.reap`. 실패하면 다른 프로세스가 회수 중이다 → 일반 재시도 루프로 돌아간다.
3. `.reap` 을 쥔 상태에서 `owner.json` 을 **다시 읽는다.** token 이 1에서 기억한 것과 다르거나 더는 stale 이 아니면 아무것도 하지 않는다(다른 프로세스가 이미 회수했고 지금 있는 것은 살아 있는 새 lock 이다).
4. 같으면 lock 디렉터리를 삭제한다.
5. `.reap` 을 삭제하고 일반 재시도 루프로 돌아가 `mkdir` 로 경쟁한다.

- 다른 프로세스의 lock 을 없애는 경로가 이것 하나뿐이고 그 안에서 token 을 다시 확인하므로, 살아 있는 lock 이 회수되는 일은 없다.
- `.reap` 은 시스템 호출 몇 번 동안만 존재한다. 회수자가 그 사이에 죽으면(crash 복구 도중의 crash) `.reap` 이 남는다. `.reap` 은 자동 회수하지 않는다 — 같은 문제가 한 단계 더 생길 뿐이기 때문이다. mtime 이 `staleAfter` 를 넘은 `.reap` 을 만나면 `StoreBusyError` 에 "`.locks/<taskId>.reap` 을 수동으로 삭제하라" 는 안내를 담는다.
- Windows 에서 다른 프로세스가 `owner.json` 을 열고 있는 순간에는 디렉터리 삭제가 `EPERM`/`EBUSY` 로 실패할 수 있다. 짧게 재시도하고, 안 되면 `.reap` 을 풀고 일반 재시도 루프로 돌아간다.

### 2.3 Task ID 발급

- 전역 lock 을 쓰지 않는다. 현재 최대 `T-NNNN` + 1 을 후보로 `mkdir <dataDir>/T-NNNN` 을 시도하고, `EEXIST` 면 +1 해서 다시 시도한다. `mkdir` 의 원자성이 유일성을 보장한다.
- 그 뒤 해당 Task 의 lock 을 잡고 일반 commit 과 같은 절차로 Task 와 첫 이벤트를 기록한다.
- ADR-0008 결정 4 와 `architecture.md` 는 "Task ID 발급을 lock 으로 직렬화한다" 고 적고 있다. 이 설계는 같은 목적(유일성)을 lock 없이 달성한다. 문서를 맞추는 일은 이 Step 의 범위 밖이다.
- 4자리 0 채움, 9999 를 넘으면 자릿수가 늘어난다(스키마 패턴 `^T-[0-9]{4,}$`).

### 2.4 commit 절차

lock 을 잡은 상태에서:

1. `.pending/commit.json` 이 있으면 복구한다(2.5).
2. `events.jsonl` 의 마지막 줄에서 `lastSeq` 를 읽는다. `change` 가 함수면 `{ lastSeq }` 로 호출한다.
3. `expectedLastSeq` 검사 → `ConflictError`.
4. writes 와, seq/task_id 를 부여한 events 를 전부 스키마 검증 → `SchemaViolationError`. **여기까지는 디스크를 건드리지 않는다.**
5. 각 write 를 `.pending/<n>.tmp` 에 쓰고 fsync. `.pending/commit.json` 에 `{ firstSeq, count, files: [{ tmp, final }] }` 를 쓰고 fsync. (final 은 Task 디렉터리 기준 상대 경로)
6. 소유 확인(2.2: `maxHold`, token) 후, 이벤트 줄들을 하나의 버퍼로 `events.jsonl` 에 append 하고 fsync. **`firstSeq` 부터 `count` 개의 줄이 모두 기록된 시점이 commit 시점이다.**
7. 뒷정리: tmp 파일들을 final 위치로 rename. `.pending/` 삭제.
8. lock 해제.

**단계별 실패 처리**

| 실패 지점 | 처리 | `commit()` 의 결과 |
|---|---|---|
| 1~4 | 디스크를 건드리지 않았다 | 해당 오류 |
| 5 | `.pending/` 을 지운다. 못 지워도 다음 접근의 복구가 지운다(이벤트가 없으므로 되돌리기) | I/O 오류 (기록 안 됨) |
| 6 | 그 자리에서 2.5 의 복구를 수행해 성립 여부를 판정한다 | 앞으로 굴렸으면 **성공**, 되돌렸으면 I/O 오류(기록 안 됨), 복구도 실패하면 `CommitOutcomeUnknownError` |
| 7 | commit 은 이미 성립했다. `.pending/` 을 남겨 두면 다음 접근이 앞으로 굴린다 | **성공** |
| 8 | lock 이 남는다. `staleAfter` 뒤에 회수된다 | **성공** |

- 7단계의 rename 은 Windows 에서 대상 파일을 다른 프로세스(백신, 에디터, 검색 인덱서, 읽는 중인 reader)가 열고 있으면 `EPERM`/`EBUSY`/`EACCES` 로 실패할 수 있다. 지수 백오프로 최대 1초쯤 재시도하고, 그래도 안 되면 `.pending/` 을 남긴 채 성공을 돌려준다. (Node 의 `fs.rename` 은 Windows 에서도 기존 파일을 덮어쓴다.)
- `.pending/` 이 남아 있는 동안 reader 는 lock 을 잡는 경로로 가서 앞으로 굴리기를 수행하므로(2.7), 옛 엔티티 내용이 보이는 일은 없다.

### 2.5 부분 실패와 복구

`.pending/commit.json` 이 남아 있으면 이전 commit 이 중간에 죽은 것이다. lock 을 잡은 프로세스가 다음을 수행한다.

- `events.jsonl` 의 마지막 줄이 개행으로 끝나지 않거나 JSON 으로 읽히지 않으면 그 줄은 잘린 쓰기다 → 제거한다.
- seq 가 `firstSeq` 이상인 이벤트 수를 센다.
  - `count` 와 같다 → commit 은 성립했다. **앞으로 굴린다**: 남은 tmp 를 final 로 rename(이미 옮겨진 것은 건너뜀), `.pending/` 삭제.
  - 그보다 적다 → commit 은 성립하지 않았다. **되돌린다**: `firstSeq` 이상의 줄을 `events.jsonl` 에서 잘라내고 `.pending/` 삭제.
- `commit.json` 자체가 없거나 읽히지 않는 `.pending/` → 5단계 도중 죽은 것이므로 이벤트는 기록되지 않았다. `.pending/` 삭제.

"append-only" 는 **성립한 commit 의 이벤트**에 대한 규칙이다. 성립하지 않은 commit 의 잔여물을 잘라내는 것은 위반이 아니다. `AGENTS.md` 7번과 `devflow-data/README.md` 의 문구는 이 해석을 담고 있지 않다(5절 F10).

복구는 몇 번을 수행해도 결과가 같다. 복구 도중에 죽으면 다음 접근이 같은 복구를 처음부터 다시 한다. 복구는 lock 을 쥔 프로세스만 수행하므로 두 프로세스가 동시에 복구하는 일은 없다.

### 2.6 검증 시점

- 쓰기: 2.4 의 4단계. `ajv`(draft 2020-12) + `ajv-formats`. 스키마는 시작 시 한 번 컴파일한다.
- 읽기: 파싱 직후 매번. 사람이 파일을 손으로 고칠 수 있는 0~1단계에서는 특히 필요하다. 성능이 문제가 되면 (mtime, size) 기준 캐시를 구현체 내부에 둘 수 있다.

### 2.7 읽기 절차

reader 는 lock 없이 시작하되, commit 과 겹쳤을 가능성이 있으면 결과를 버린다. (v1 의 "`.pending` 이 안 보이면 그냥 읽는다" 는 확인과 읽기 사이에 commit 이 시작될 수 있어 틀렸다.)

1. 앞 표식을 읽는다: `.pending/` 의 존재 여부, `events.jsonl` 의 크기와 mtime.
2. 대상을 읽는다(`task.yaml`, 또는 `events.jsonl` 전체).
3. 뒤 표식을 같은 방법으로 읽는다.
4. 앞뒤 모두 `.pending/` 이 없고 `events.jsonl` 의 크기와 mtime 이 같으면 읽은 내용을 쓴다.
5. 아니면 짧은 백오프로 1부터 다시 한다(최대 3회). 그래도 안 되면 **lock 을 잡고** 읽는다. lock 을 잡으면 commit 이 끝나기를 기다린 셈이고, 죽은 commit 이 있었다면 복구(2.5)를 수행한 뒤 읽게 된다.

왜 충분한가:
- 모든 commit 은 이벤트를 1개 이상 append 하므로 `events.jsonl` 의 크기를 반드시 바꾼다. 크기가 앞뒤로 같으면 그 사이에 성립한 commit 의 6단계는 지나가지 않았다.
- 크기만 보면 놓치는 경우가 하나 있다: 창 안에서 commit 이 append 한 뒤 죽고 다른 프로세스가 그것을 되돌려(잘라내) 크기가 원래대로 돌아온 경우다. append 와 잘라내기는 모두 mtime 을 바꾸므로 mtime 비교가 이를 잡는다.
- 6단계가 창 이전에 끝났고 7단계(rename)가 창 안에서 진행된 commit 은 앞 표식에서 `.pending/` 이 보인다(`.pending/` 은 5단계에 생겨 7단계 끝에 사라진다).
- 따라서 4의 조건을 통과한 읽기는 어떤 commit 과도 겹치지 않았다. 잘린 줄, 나중에 되돌려질 이벤트, 한 commit 의 이벤트 일부, 이벤트는 있는데 엔티티는 옛것인 상태 중 어느 것도 보이지 않는다.
- 2에서 파일이 rename 되는 중이라 `EPERM`/`EBUSY`/`ENOENT` 가 나면 겹친 것으로 보고 5로 간다.

`list` 는 Task 마다 이 절차를 따로 수행한다.

읽기 전용 매체(또는 쓰기 권한이 없는 사용자)에서는 5의 lock 경로를 쓸 수 없다. 이 경우 `StoreBusyError` 다. 남은 `.pending/` 을 복구할 수 없으므로 읽기 전용 소비자는 지원 대상이 아니다.

### 2.8 한계

- **전원 장애에 대한 내구성은 보장하지 않는다.** 보장하는 것은 프로세스 crash 에 대한 원자성이다. Windows 에서는 디렉터리 fsync 가 불가능해 rename 과 `.pending/` 삭제의 내구성이 NTFS 저널에 달려 있다. `devflow-data` 가 git repo 이고 Step 전이마다 commit 되므로(ADR-0007) 최악의 경우 마지막 git commit 으로 돌아갈 수 있다.
- **한 호스트에서만 쓴다.** 여러 호스트가 같은 `dataDir`(공유 폴더, 네트워크 드라이브)을 쓰는 것은 지원하지 않는다. `mkdir` 의 원자성과 pid 확인이 성립하지 않고 호스트 간 시계 차이가 stale 판정을 깨뜨린다. 여러 호스트가 필요해지는 시점이 DB 구현체로 넘어갈 시점이다(roadmap 4단계).
- **남는 위험 하나**: 소유자가 2.2 의 소유 확인을 통과한 직후부터 append 를 마칠 때까지의 구간에서 50초 넘게 멈췄다가 깨어나면, 그 사이 lock 이 회수되어 두 프로세스가 같은 seq 를 쓸 수 있다. 이 구간은 시스템 호출 한두 번 길이다. 발생하면 `readEvents` 의 연속성 검사가 `SchemaViolationError(read)` 로 드러낸다. 파일 기반으로는 이 이상 막을 수 없고, DB 구현체에서는 사라진다.
- `.reap` 이 남는 이중 장애는 사람이 지워야 한다(2.2).

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
| F8 | `.locks/`, `.pending/` 이 `devflow-data/.gitignore` 에 없다 | 구현 Step 에서 추가 |
| F9 | 대상 repo 안에 있는 문서 산출물(이 문서가 그 예)을 Artifact 로 어떻게 표현할지 모호하다. `type: document` 인데 내용은 `content_key` 가 아니라 `code`(commit 참조)로 가리켰다 | Artifact 에 "내용의 위치" 를 명시하는 필드(`stored_in: store \| repo`)와 repo 내 경로 목록을 추가 |
| F10 | `AGENTS.md` 7번과 `devflow-data/README.md` 의 "이벤트를 수정·삭제하지 않는다" 는 성립하지 않은 commit 의 잔여물을 잘라내는 복구(2.5)와 글자 그대로는 충돌한다 | 두 문서의 문구를 "성립한 commit 의 이벤트" 로 고친다 |
| F11 | GateResult 의 `verdict` 가 pass/fail 뿐이라 "통과했지만 구현 전에 고쳐야 할 결함이 있다"(G-001 이 그랬다)를 표현하지 못한다. 사람이 comments 를 다 읽어야 알 수 있다 | `comments` 를 `{ severity: defect \| risk \| note, text }` 로 구조화하거나 verdict 에 `pass_with_concerns` 추가 |

F9~F11 은 v1 에 대한 Gate(G-001)와 검토 과정에서 나왔다.

F2, F6 은 작은 스키마 변경이고 이번 Task 의 AC 와 무관하다. 이번 Task 에서 할지는 Planner 가 판단한다. F3, F5 는 해당 구성 요소를 만들 때가 적기다. F4, F7, F8 은 `devflow-data` 의 문서·설정 변경이다.
