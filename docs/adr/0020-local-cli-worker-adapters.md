# ADR-0020: 공통 로컬 실행 관리와 세 CLI Worker 어댑터

- 상태: Accepted
- 날짜: 2026-09-20
- ADR-0019의 복구 계약을 유지하며 실제 신규 Worker/write 실행에 확장한다. ADR-0010의 resume·메시지·read 격리·자동 재시도는 여전히 후속이다.

## 상황

PR #1과 #2가 main에 병합되어 Workspace와 회수 가능한 fake 실행이 준비됐다. fake 안에 있는 프로세스 관리 전체를 백엔드마다 복제하면 시작 여부와 수집의 계약이 갈라진다. 또한 제출 시 미래 commit SHA를 지정하는 방식은 실제 코드 작업의 증거가 될 수 없다.

## 결정

1. `src/runner/local/`이 prepare, 영구 launch claim, detached supervisor, 실행 관찰, 종료 영수증, 로그와 출력 스냅샷을 소유한다. 네 어댑터(fake 포함)는 같은 `LocalRunner`를 사용한다. 어댑터는 검증된 요청으로 실행 파일·인자 배열·stdin·프로세스 한정 환경·출력 위치를 구성한다. 백엔드 플래그는 각 어댑터 안에만 있다. commands/queries는 Runner 인터페이스와 논리 참조만 사용한다.
2. prepare는 `launch.json`을 먼저, `request.json`을 마지막에 게시한다. 부분 준비를 정상 요청으로 덮어쓰지 않는다. submit은 저장한 실행 계획만 사용하며 새 버전의 CLI 인자를 재조립하지 않는다. supervisor는 스키마를 검사하고 실제 CLI의 종료를 확인한다. 공유 Store와 시작의 원자성을 가정하지 않으며 영구 시작 표식을 지우지 않는다.
3. 명시적 입력의 backend와 model은 prompt·산출물 정책과 함께 digest에 포함한다. 생략한 backend는 기존 fake 입력으로만 해석한다. CLI의 `--backend`와 입력의 backend가 같아야 한다. model 생략 시 실제 CLI 기본값을 사용하며 선택 모델을 추정해서 Run에 쓰지 않는다. `--version`의 숫자 버전만 Run에 기록하며 확인 불가면 `unavailable`이다. 조회/수집에는 설치나 인증이 필요하지 않다.
4. 실제 Worker에게 호출자의 prompt와 파일 출력 계약만 전달한다. Context/Ledger를 조립하지 않는다. prompt는 stdin으로 보내 Windows 인자 길이·shell quoting 문제를 피한다. npm bin도 shell을 거치지 않고 실행 파일 또는 Node 엔트리로 해석한다. 백엔드의 JSON-schema 응답 옵션이나 stdout을 역할 출력으로 쓰지 않는다.
5. 실제 출력은 실행별 `output/worker-output.json`이다. 어댑터는 Task worktree와 이 전용 출력 디렉터리에 필요한 쓰기만 허용한다. Claude는 acceptEdits와 비대화형 권한 거부, Codex는 workspace-write sandbox와 approval_policy=never, OpenCode는 파일 도구 허용과 그 밖의 ask 정책을 사용한다. 이는 작업 종류에 따라 명령 실행이 거부될 수 있는 정책이며 권한/샌드박스 전체 우회가 아니다. 설정·인증은 자동 설치/로그인/변경하지 않는다. 기존 CLI·프로젝트 설정 및 조직 정책은 동작에 영향을 줄 수 있으며 OS 수준의 완전 격리를 주장하지 않는다.
6. `workspace:code`를 최소 지연 산출물 출처로 추가한다. 제출 시 Step의 code_change와 매핑하고 Workspace의 기준 SHA·Task branch를 로컬 요청에 고정한다. 성공 종료 뒤 `workspace/git/artifact.mjs`가 실제 branch, 기준 commit의 ancestry, clean 상태와 HEAD를 검사한다. 시스템이 확인한 base/head를 출력과 함께 종료 영수증에 고정한다. collect는 그 SHA를 기존 completeRun에 넘겨 Artifact·Run·Step·이벤트를 한 commit으로 기록한다. 수집 전에 HEAD가 더 진행돼도 원래 영수증을 쓴다.
7. dirty 상태·branch 불일치·Git 검증 실패는 invalid_output이며 변경을 보존한다. 자동 add/commit/reset은 없다. 실제 어댑터는 제출 시 고정한 `code:`/`repo:` 출처를 거부한다. 문서는 기존 `blob:work-notes`로 받으며 AI가 주장한 SHA/경로를 공식 산출물로 복사하지 않는다. fake의 기존 고정 출처와 입력 digest는 호환성을 위해 유지한다. 범용 파일 Artifact 수집·patch 저장은 도입하지 않는다.
8. 기존 fake 로컬 요청(backend 및 launch.json 없음)은 공통 supervisor의 제한된 호환 경로로 실행한다. 이미 실행 중인 supervisor와 기존 종료 영수증은 변경하지 않는다. 새 prepare는 모든 어댑터에서 실행 계획을 보관한다.

## 검증과 한계

세 실제 어댑터는 통제 가능한 Node 대역 CLI로 동일한 계약을 검사한다. 이 검사는 실제 모델 연동 검증과 구별한다. fake의 기존 강제 종료/복구 테스트도 유지한다. Claude Code 2.1.278와 Codex 0.154.0은 각각 임시 repo·별도 Task Workspace·테스트 Store에서 실제 신규 세션 1회로 파일 생성과 역할 출력, 실행 중 호출자 SIGKILL, 새 Store/Runner 회수, 반복 수집을 확인했다. OpenCode는 설치되어 있지 않아 공식 문서/공식 소스와 대역으로 검증했으며 **실제 OpenCode 연동은 미검증**이다.

종료 영수증 없는 출력, supervisor 유실, 로컬 파일 손상, 영구 시작 표식만 남은 경우는 unknown이다. 자동 재실행·잠금 회수·출력 재시도·작업공간 정리는 없다. 살아 있는 supervisor가 후에 결과를 게시하면 같은 실행을 회수할 수 있다. 그렇지 않으면 사람이 기존 프로세스와 변경을 확인해야 한다. 프로세스 crash 복구를 검증했으며 전원 장애·분산 실행·동시 외부 Git 변경의 원자적 격리는 보장하지 않는다.

옵션/버전 출처와 재현 방법은 [Runner 계약](../design/runner.md), [운영 예제](../stage0-manual-operation.md)를 따른다.
