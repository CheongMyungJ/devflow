# Worker 실행 계약

결정 배경은 [ADR-0019](../adr/0019-recoverable-worker-execution.md). 필드 정의는 `schemas/run.schema.json`, `worker-execution-input.schema.json`, `fake-worker-input.schema.json`, `runner-local-*.schema.json`이 기준이다.

## 공개 경로

- `commands.submitWorker(ctx, { taskId, stepId, runId, input })`: 준비된 Workspace에서 실행을 제출한다. `runId`는 다음 예상 ID이며 Store가 발급/검사한다. 응답 대기 중 종료돼도 같은 ID/입력으로 재호출한다.
- `queries.getWorkerExecution(ctx, { taskId, runId })`: 실행 관찰 또는 이미 수집한 Run/Artifact를 반환한다. 공유 기록을 쓰지 않는다.
- `commands.collectWorker(ctx, { taskId, runId })`: 종료가 확인된 결과만 검증·기록한다. prepared/running/unknown은 그대로 반환한다.

확장 Context는 기존 Store/Workspace와 Runner를 주입받는다. `submitRun`은 제출 기록만, `completeRun`은 Worker 출력 스키마 검사와 Artifact 발급·Step 전이, `failRun`은 확인한 실패 기록을 맡는다. 세 명령의 기존 기록 전용 동작은 유지한다. 관리형 Run의 반복 수집은 collectWorker가 terminal Run을 확인하여 멱등화한다. 외부에서 기록 전용 complete-run/fail-run으로 실행 중인 관리형 Run을 임의로 닫지 않는다.

공유 `run.status`는 수집 전까지 `submitted`로 유지한다. 실제 실행 관찰은 응답의 `execution.state`이며, `running` 조회만으로 공유 이벤트를 추가하지 않는다.

입력과 Artifact 출처는 제출 때 고정한다. 객체의 키 순서는 digest에 영향을 주지 않으며 prompt 문자열과 배열 순서는 입력의 일부다. 기존 Run에 다른 입력/Step/backend를 보내면 거부한다. fake는 Git commit이나 Artifact 출처의 실재를 검증하지 않는다. 테스트할 출처는 호출자가 명시하며 기존 completeRun의 출처 규약을 따른다. Context/Ledger 자동 조립은 없다.

## 로컬 실행과 상태

Runner는 `prepare / submit / inspect`를 제공한다. `prepare`는 실행하지 않고 요청만 고정한다. `submit`은 같은 요청에만 최초 시작을 허용한다. `inspect`는 완료를 기다리지 않고 상태/결과 스냅샷을 반환한다(TCP 확인 타임아웃 700ms). 한 번의 submit은 supervisor 시작 확인을 약 1초 동안 시도하며 진행 중인 단일 조회 시간은 추가될 수 있다. Worker 완료를 기다리지는 않는다.

| 상태 | 의미와 호출자 행동 |
|---|---|
| prepared | 공유 제출과 로컬 요청이 있고 시작 시도 전. 같은 submit-worker로 시작 가능 |
| running | 해당 실행 UUID를 응답하는 supervisor가 살아 있다. 나중에 status/collect |
| completed, collected=false | exit 0과 출력 파일을 확인했으며 worker-output 스키마도 통과. collect로 기록 |
| failed, collected=false | 확인된 process_exit 또는 invalid_output. collect로 failRun 기록 |
| unknown | 로컬 기록 유실/손상, 시작 표식만 존재, supervisor 불통 등. 자동 실패 처리나 새 실행 금지 |
| collected=true | 공유 Run이 terminal. 로컬 기록이 없어도 기존 공유 결과 반환 |

스키마는 통과했지만 명시한 `blob:work-notes`를 공급할 work_notes가 없으면 수집 시 invalid_output으로 실패 처리한다. Step 상태 등 기존 completeRun 조건이 바뀌었으면 수집을 거부하고 종료 결과를 남겨 둔다. Store 실패를 Worker 실패로 기록하지 않는다.

머신별 파일은 `<runner-dir>/<Task>/<Run>/<UUID>/` 아래에 있다. `request.json`, `launch-claim/`, `supervisor-claim/`, `supervisor.json`, `worker.json`(진단), `output.json`, `result.json`과 원자적 게시 도중 남은 임시 파일이 있을 수 있다. 이 경로 구조는 fake 구현만 안다. 공유 기록에는 머신 경로/PID/포트를 자동으로 넣지 않는다. runner-dir는 공유 data-dir 및 Task worktree 밖에 두며 같은 머신·같은 디렉터리를 계속 사용한다.

## 수동 확인

unknown이면 먼저 원래 `--runner-dir`와 머신을 사용했는지 확인한다. 원래 감독 프로세스가 응답하거나 종료 영수증이 나중에 생기면 같은 status/collect로 회수할 수 있다. 출력만 있거나 PID가 존재한다는 이유로 완료/실패를 기록하지 않는다. supervisor가 사라져도 Worker는 남아 있을 수 있다.

영구 시작 표식은 자동/수동 재시도용 잠금이 아니다. **삭제하여 같은 Run을 다시 실행하지 않는다.** 프로세스 명령줄·시작 정보와 Workspace 변경을 사람이 대조하고 기존 Worker가 더 실행될 수 없음을 확인한다. 그 뒤 회수가 불가능한 실행은 이유를 적어 기존 fail-run으로 종료 기록하고, 필요한 경우 새 Run ID로 제출한다. 손상된 결과를 프로그램이 덮어쓰거나 실행을 대체하지 않는다. Workspace 잠금/불완전 checkout의 수동 절차는 [Workspace 계약](workspace.md)을 따른다.

## 미지원

실제 AI, read 격리, resume, 메시지 전달, stream/transcript, cancel, 자동 출력 재시도, Gate, advance, 분산 실행, 실행 디렉터리 자동 정리는 제공하지 않는다. fake의 capabilities는 모두 false이며 인터페이스에 성공하는 stub을 두지 않는다. 추가 요청 옵션도 스키마에서 거부한다. 프로세스 crash 복구를 목표로 하며 전원 장애 내구성은 보장하지 않는다.
