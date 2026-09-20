# Worker 실행 계약

결정 배경은 [ADR-0019](../adr/0019-recoverable-worker-execution.md), [ADR-0020](../adr/0020-local-cli-worker-adapters.md). 필드 정의는 `schemas/run.schema.json`, `worker-execution-input.schema.json`, `fake-worker-input.schema.json`, `runner-local-*.schema.json`이 기준이다.

## 공개 경로

- `commands.submitWorker(ctx, { taskId, stepId, runId, input })`: 준비된 Workspace에서 실행을 제출한다. `runId`는 다음 예상 ID이며 Store가 발급/검사한다. 응답 대기 중 종료돼도 같은 ID/입력으로 재호출한다.
- `queries.getWorkerExecution(ctx, { taskId, runId })`: 실행 관찰 또는 이미 수집한 Run/Artifact를 반환한다. 공유 기록을 쓰지 않는다.
- `commands.collectWorker(ctx, { taskId, runId })`: 종료가 확인된 결과만 검증·기록한다. prepared/running/unknown은 그대로 반환한다.

확장 Context는 기존 Store/Workspace와 Runner를 주입받는다. `submitRun`은 제출 기록만, `completeRun`은 Worker 출력 스키마 검사와 Artifact 발급·Step 전이, `failRun`은 확인한 실패 기록을 맡는다. 세 명령의 기존 기록 전용 동작은 유지한다. 관리형 Run의 반복 수집은 collectWorker가 terminal Run을 확인하여 멱등화한다. 외부에서 기록 전용 complete-run/fail-run으로 실행 중인 관리형 Run을 임의로 닫지 않는다.

공유 `run.status`는 수집 전까지 `submitted`로 유지한다. 실제 실행 관찰은 응답의 `execution.state`이며, `running` 조회만으로 공유 이벤트를 추가하지 않는다.

입력과 Artifact 출처 정책은 제출 때 고정한다. backend와 model도 digest에 포함한다. 실제 백엔드는 backend를 입력에 명시하고 Context의 Runner 및 CLI 선택과 일치시킨다. 생략은 기존 fake만 뜻한다. model 생략 시 CLI 기본값을 사용하며 실제 선택 모델을 추측하지 않는다. 객체의 키 순서는 digest에 영향을 주지 않으며 prompt 문자열과 배열 순서는 입력의 일부다. 기존 Run에 다른 입력/Step/backend를 보내면 거부한다. fake의 기존 고정 출처는 Git commit 실재를 검증하지 않는 시험 입력으로 유지한다. Context/Ledger 자동 조립은 없다.

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

머신별 파일은 `<runner-dir>/<Task>/<Run>/<UUID>/` 아래에 있다. `request.json`, `launch.json`, `launch-claim/`, `supervisor-claim/`, `supervisor.json`, `process.json`(spawn 진단), `result.json`, `stdout.log`, `stderr.log`과 원자적 게시 도중 남은 임시 파일이 있을 수 있다. 실제 출력은 `output/worker-output.json`, fake는 기존 `output.json` 및 `worker.json`을 쓴다. 실행 기록의 위치는 공통 local 구현만 알며 어댑터는 전달받은 실행 디렉터리 안에서 출력 위치를 정한다. 공유 기록에는 머신 경로/PID/포트를 자동으로 넣지 않는다. runner-dir는 공유 data-dir 및 Task worktree 밖에 두며 같은 머신·같은 디렉터리를 계속 사용한다.

## 수동 확인

unknown이면 먼저 원래 `--runner-dir`와 머신을 사용했는지 확인한다. 원래 감독 프로세스가 응답하거나 종료 영수증이 나중에 생기면 같은 status/collect로 회수할 수 있다. 출력만 있거나 PID가 존재한다는 이유로 완료/실패를 기록하지 않는다. supervisor가 사라져도 Worker는 남아 있을 수 있다.

영구 시작 표식은 자동/수동 재시도용 잠금이 아니다. **삭제하여 같은 Run을 다시 실행하지 않는다.** 프로세스 명령줄·시작 정보와 Workspace 변경을 사람이 대조하고 기존 Worker가 더 실행될 수 없음을 확인한다. 그 뒤 회수가 불가능한 실행은 이유를 적어 기존 fail-run으로 종료 기록하고, 필요한 경우 새 Run ID로 제출한다. 손상된 결과를 프로그램이 덮어쓰거나 실행을 대체하지 않는다. Workspace 잠금/불완전 checkout의 수동 절차는 [Workspace 계약](workspace.md)을 따른다.

## 미지원

read 격리, resume, 메시지 전달, stream/transcript, cancel, 자동 출력 재시도, Gate, advance, 분산 실행, 실행 디렉터리 자동 정리는 제공하지 않는다. 네 어댑터의 해당 capabilities는 모두 false이며 인터페이스에 성공하는 stub을 두지 않는다. 추가 요청 옵션도 스키마에서 거부한다. 프로세스 crash 복구를 목표로 하며 전원 장애 내구성은 보장하지 않는다.

## 공통 계층과 실제 CLI 어댑터

공통 계층은 `src/runner/local/`이다. `LocalAdapter`는 요청 검증과 실행 계획 생성만 담당한다. 새 실행 옵션은 입력 스키마·digest·로컬 요청·어댑터 검증·계약 테스트를 함께 바꾼다. 임의 CLI 인자, read, 다른 역할, resume/session ID, 실행 중 메시지는 스키마/런타임에서 거부한다.

prepare는 실행 계획을 먼저 게시한 뒤 요청을 게시한다. submit은 저장된 계획을 사용한다. 부분 기록이나 손상은 덮어쓰지 않는다. 실행 파일은 shell 없이 인자 배열로 spawn하며 prompt는 stdin에 보낸다. Windows npm 설치는 PATH 아래 package의 bin을 읽어 Node 또는 native exe로 직접 실행한다. 사용자 지정 .cmd/.ps1 wrapper는 지원하지 않는다. API 조립에서 각 Runner의 선택적 `CliCommand`를 주입할 수 있지만 기존 실행의 계획은 바뀌지 않는다. 기존 fake 요청(backend 및 launch.json 없음)도 제한된 호환 경로로 처리한다.

supervisor 자체는 Node 실행 파일의 디렉터리를 cwd로 사용하고 관리 파일은 절대 경로로 접근한다. Task 디렉터리를 불필요하게 붙잡지 않기 위한 Windows 대응이다. 실제 Worker subprocess의 cwd는 반드시 검증된 Task worktree이며 어댑터가 새 worktree를 만들지 않는다.

| backend | 신규 실행/권한 정책 | 확인한 로컬 버전 |
|---|---|---|
| fake | 기존 fake-worker-input과 Node subprocess | 내부 1 |
| claude-code | print, text stdin, acceptEdits, permission-prompts none, no-session-persistence; 출력 디렉터리 add-dir | 2.1.278 |
| codex | exec, workspace-write, approval_policy=never, Task cd, 출력 add-dir, ephemeral; stdin `-` | 0.154.0 |
| opencode | run, Task dir, build agent; model은 provider/model; 프로세스 한정 설정으로 파일 도구 허용, 나머지 ask, 외부 출력 디렉터리만 허용 | 설치 없음, 실제 버전/연동 미검증 |

stdout/stderr는 로컬 로그이며 역할 JSON은 파일만 읽는다. backend 전용 structured-output 옵션은 쓰지 않는다. 모델이 파일을 먼저 만들더라도 종료 영수증 전에는 completed가 아니다. 권한 없는 작업은 CLI 정책에 따라 거절되거나 출력 실패가 될 수 있다. 권한 전체 우회로 자동 재시도하지 않는다. CLI의 사용자/프로젝트/관리자 설정을 변경하지 않으며 이 설정과 CLI 버전 변경은 실행에 영향을 줄 수 있다. 기록된 model은 요청값이며 실제 모델 응답의 정규화/검증은 이번 범위 밖이다.

호환성은 위 옵션을 모두 제공하는 CLI를 전제로 한다. Claude permission-prompts와 Codex ephemeral 등은 오래된 버전에 없을 수 있다. 임의 최소 버전을 추정하지 않는다. 지원되지 않는 옵션은 CLI의 확인된 실패로 처리하며 자동 옵션 제거/우회/업데이트는 없다. `--version`에서 숫자 버전을 읽을 수 없으면 `unavailable`을 기록한다. 실행 파일이 없으면 supervisor가 process_exit을 기록한다. 조회/수집에는 CLI 설치나 인증이 필요하지 않다.

2026-09-20에 로컬 `--version`, Claude `--help`, Codex `exec --help`와 다음 공식 자료를 확인했다.

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [OpenCode CLI](https://opencode.ai/docs/cli/), [permissions](https://opencode.ai/docs/permissions/), [공식 run 구현의 stdin 처리](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)

OpenCode의 run/dir/model/build, stdin, OPENCODE_CONFIG_CONTENT를 이 자료에 맞췄다. 설치/로그인하거나 모델을 호출하지 않았다. **실제 OpenCode 연동은 미검증**이다. 문서와 개발 branch의 변동 가능성이 있으므로 사용 전 설치된 버전의 도움말/정책 호환성을 확인해야 한다.

## 실행 후 산출물 확정

실제 백엔드는 `blob:work-notes`(문서) 또는 `workspace:code`(code_change)만 받는다. Step outputs의 이름/타입을 제출 때 검사한다. 미래 SHA나 AI가 주장한 참조는 사용하지 않는다. fake의 기존 `code:`/`repo:` 입력과 기록 전용 complete-run은 유지한다.

`workspace:code`는 Workspace의 최초 고정 SHA를 base로 사용하며 exit 0 뒤 Git 구현이 Task branch의 clean HEAD와 ancestry를 확인한다. untracked 파일도 dirty에 포함된다. 성공 시 실제 base/head를 종료 영수증에 고정하고 collect는 이 참조로 completeRun을 호출한다. HEAD가 나중에 진행돼도 같은 영수증을 쓴다. 자동 git add/commit은 없으므로 코드 Artifact가 필요한 작업의 commit은 호출자가 명시하고 CLI 권한 내에서 수행돼야 한다. 미커밋 결과만 남았으면 invalid_output으로 실패를 수집하고 변경은 보존한다. 필요한 Git 증거가 누락/손상됐으면 사람이 확인한다.

Blob 문서는 기존 work_notes를 Run blob으로 저장하고 Artifact의 논리적 content_key로 참조한다. 출력·Git 검증 성공 이후 Store 오류나 Step 전이 거부는 Worker 실패로 바꾸지 않는다. Artifact/Run/Step/이벤트는 기존 completeRun의 한 commit으로 일관되게 기록된다.

## 검증 재현

`npm test -- tests/runner`는 fake 및 세 어댑터의 통제된 Node CLI 테스트다. 실제 모델을 호출하지 않는다. 인자/입력/cwd/model, 성공/지연/비정상 종료/파일 누락/stdout만 존재/JSON·스키마 오류, 실행 파일 부재, caller SIGKILL, 중복/unknown/손상/supervisor 유실, 다른 Task의 같은 Run ID, 사용자 Git 변경 보존, 종료 SHA 스냅샷, 운영 입구를 검사한다.

실제 모델 테스트는 별도 opt-in 개발 검증기다. `node tests/runner/real-smoke.mjs claude-code` 또는 `node tests/runner/real-smoke.mjs codex`를 명시적으로 실행한다. 정상 인증된 CLI가 있어야 하며 비용/사용량이 발생할 수 있다. 임시 저장소와 테스트 데이터만 만들고 실행 중 caller를 SIGKILL한 뒤 새 Store/Runner로 회수한다. 자동 삭제는 하지 않으며 출력한 임시 경로에 `verification.json`과 로그를 남긴다. 이 검증기는 OpenCode 선택을 거부한다.

이번 Windows 실측은 각 CLI 한 세션씩 성공했다. 지정된 `smoke.txt` 내용, Worker cwd, 역할 출력 스키마, Run completed, Artifact 1개, run.completed/artifact.version_added 각각 1회와 반복 수집을 확인했다. Claude는 sonnet 요청, Codex는 CLI 기본 모델을 사용했다. 실제 세션의 Artifact는 보고 문서이며 commit SHA 확정은 실제 Git + 대역 CLI 계약 테스트로 검증했다. 다른 OS, 모든 모델/CLI 버전, read 격리, 권한이 필요한 임의 shell 명령까지 검증한 것은 아니다.

최종 자동 검증: Windows, Node.js 22.15.1에서 `npm run typecheck` 통과, `npm test` 46개 파일·678개 테스트 통과(2026-09-20). 이 중 실제 어댑터 대역 계약은 42개, 추가 운영 입구는 3개이며 기존 fake 회귀와 옛 준비 기록 호환 검사도 포함한다. 실제 모델 검증 2회는 이 테스트 수에 포함하지 않는다.
