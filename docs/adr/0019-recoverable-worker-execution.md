# ADR-0019: 회수 가능한 Worker 실행과 보수적인 시작 판정

- 상태: Accepted
- 날짜: 2026-09-20
- ADR-0010의 Runner 비동기 경계를 현재 fake 구현에 구체화한다. 실제 백엔드·resume·메시지·stream·cancel은 미구현이다.

## 상황

기존 Runner는 Task 안에서만 유일한 Run ID를 단독 조회 키로 받고, 프로세스 안의 Promise/SessionHandle을 실행 결과로 취급했다. 호출자가 종료되면 핸들이 사라지고, Store 제출과 subprocess 시작 사이의 실패를 구별할 수 없었다. Workspace는 PR #1로 main에 반영되었다. 이번 작업은 준비된 Workspace에서 fake Worker 한 번의 제출·관찰·결과 회수를 구현한다.

## 결정

1. Runner 키는 Task ID + Run ID + 실행 UUID다. UUID는 다른 데이터 저장소에서 발급한 같은 Task/Run도 구별한다. 공유 Run에는 UUID, Workspace ID, 입력 digest만 추가한다. 명시적 입력은 Run 소유 blob으로 제출과 함께 저장하며 스키마를 기준으로 타입을 생성한다. 같은 Run에 다른 입력/Step/backend를 보내면 거부한다. Run ID는 호출자가 예상 다음 ID를 명시하고 실제 발급은 기존 Store가 한다.
2. 순서는 **로컬 prepare → submitRun commit → Runner submit**이다. prepare는 프로세스를 만들지 않는다. Store commit이 실패하거나 중단되면 로컬의 고아 요청만 남을 수 있다. 기록된 Run을 재제출할 때 로컬 prepare를 다시 하지 않는다. 따라서 다른 머신/잘못된 runner-dir/로컬 정보 유실을 새 실행으로 오인하지 않는다.
3. 로컬 submit은 영구 `launch-claim` 디렉터리를 원자적으로 만든 뒤 detached supervisor를 시작한다. 표식은 자동 삭제하지 않는다. supervisor도 별도 claim으로 Worker 시작을 한 번만 허용한다. 겹친 시작은 충돌 오류 또는 기존 실행 관찰로 끝나며 Worker를 중복 생성하지 않는다. 시작 표식 뒤 spawn 전의 중단은 실제로 실행되지 않았더라도 **unknown**이다.
4. 실행 UUID/요청은 프로세스 시작 전에 이미 양쪽에 있으므로 호출자의 사후 PID 기록에 의존하지 않는다. supervisor는 Task worktree에서 Worker를 실행하고 exit를 관찰하여 결과 파일을 원자적으로 게시한다. Worker 출력 파일 원문을 결과에 담아 수집 전에 출력 파일이 바뀌더라도 같은 결과를 사용한다. stdout은 사용하지 않는다.
5. 실행 중 여부는 loopback TCP 응답의 실행 UUID로 확인한다. PID, mtime, 출력 존재 여부만으로 running/failed를 추정하지 않는다. supervisor가 사라졌거나 기록이 손상되면 unknown이다. Worker만 비정상 종료하면 살아 있는 supervisor가 process_exit으로 기록한다. exit 0이 확인된 뒤 출력 파일이 없으면 invalid_output이다. 완료 조회 시 worker-output 스키마를 검사하며 수집에서도 검증한다.
6. collectWorker는 기존 completeRun/failRun을 사용한다. 완료 Run + Artifact + blob + 이벤트는 기존 한 commit으로 기록한다. terminal Run 자체가 수집 영수증이다. 재수집은 기존 결과만 읽으며 로컬 collected 표식이나 추가 commit을 쓰지 않는다. 충돌은 안전하게 중단할 수 있고, Store의 결과 불명 commit은 기존 확인 규약을 따른다.
7. 로컬 요청·supervisor·결과는 공유 데이터 밖의 명시적 runner-dir에만 저장한다. 어댑터가 파일 위치와 subprocess를 알고, commands/queries는 Runner 인터페이스와 논리 blob만 사용한다. fake의 prompt 형식은 어댑터만 해석한다. worker/write만 지원하고 추가 옵션과 read 요청은 거부한다. 미지원 기능을 성공했다고 응답하는 stub은 두지 않는다.
8. 자동 재실행·출력 재시도·실패 시 새 Run 생성은 하지 않는다. 사람이 unknown을 확인할 때도 시작 표식을 지워 같은 ID로 재실행하지 않는다. 기존 실행이 종료되었다는 근거를 확인한 뒤 필요한 경우 명시적으로 fail-run하고 새 Run을 제출한다.

## 중단 경계와 대안

| 중단 위치 | 재호출 결과 |
|---|---|
| 로컬 prepare 뒤 공유 제출 전 | 프로세스 없음. 같은 예상 Run ID로 새 요청 준비 가능. 고아 디렉터리는 남긴다 |
| 공유 제출 뒤 시작 표식 전 | 같은 로컬 요청이 있으면 자동으로 최초 시작 |
| 시작 표식 뒤 spawn/ack 전 | 실행 여부 불명. 새 실행을 만들지 않고 수동 확인 |
| supervisor 시작 뒤 호출자 종료 | supervisor가 응답하면 running, 종료 영수증이 있으면 회수 |
| 출력 생성 뒤 supervisor 종료 영수증 전 | supervisor 생존 시 계속 관찰, 유실 시 출력만 보고 완료로 간주하지 않고 unknown |
| 종료 영수증 뒤 Store 완료 전 | 기존 출력 검증 후 completeRun/failRun |
| Store 완료 뒤 응답 전 | terminal Run을 읽어 반환. Artifact/이벤트 추가 없음 |

Store와 프로세스 시작을 한 트랜잭션처럼 감싸는 방안은 외부 프로세스를 rollback할 수 없어 제외했다. PID 존재 검사와 자동 stale 잠금 회수는 PID 재사용/일시 정지/부분 기록을 정확히 구별하지 못하므로 제외했다. 시작을 무조건 재시도하면 중복 Worker가 만들어질 수 있어 at-most-once 시작 시도를 선택했다. 서버·큐·분산 lease는 현재 범위보다 크다.

## 검증과 한계

Windows에서 실제 Node 자식 프로세스와 임시 Git 저장소를 사용한다. 호출자를 제출 직후, 실행 중, 완료 commit 직전·직후에 SIGKILL하고 새 Store/Runner로 회수한다. 다른 Task의 R-001, 겹친 제출, 다른 입력, 실패/잘못된 출력/unknown, CLI, 사용자 Git 변경 보존을 검사한다. 전원 장애, 파일의 임의 삭제/복원, 다른 호스트 공유 디렉터리, OS 프로세스 트리 전체 종료에 대한 자동 복구는 보장하지 않는다. claim을 지우지 않으며 자동 정리는 없다.
