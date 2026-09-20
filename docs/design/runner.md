# Runner 실행 계약

현재 구현은 ADR-0019·0020의 복구 가능한 Worker를 ADR-0021의 역할 실행으로 확장한다. 필드 정의는 `schemas/*.json`, 사용 예는 [실행 사용법](../execution-usage.md)을 따른다.

## 실행과 수집

`Runner.prepare`는 요청·실행 계획을 로컬에 고정하고 실행하지 않는다. `submit`은 같은 요청에 대해서만 최초 실행을 허용한다. `inspect`는 완료를 기다리지 않고 상태를 조회한다. 신규 옵션도 스키마 → digest → 요청 → 어댑터 검사 → 실행 기록을 함께 통과한다.

| 관찰 상태 | 의미와 처리 |
|---|---|
| prepared | 로컬 준비 완료, 최초 시작 전. 동일 제출로 시작 가능 |
| running | 해당 실행 UUID를 응답하는 supervisor가 살아 있음 |
| completed, collected=false | 종료와 출력 스냅샷 확인. 역할 출력 검증 뒤 collect로 기록 |
| failed, collected=false | 확인된 프로세스·출력·timeout·취소·read 위반. collect로 실패 종류 기록 |
| unknown | 실행 증거 유실·손상·supervisor 불통. 자동 실패·재실행 금지 |
| collected=true | 공유 기록 반영 완료. 로컬 실행 기록이 없어도 기존 결과 반환 |

Worker의 `blob:work-notes`가 필요한데 출력에 노트가 없으면 수집 때 거부한다. 역할 출력과 실행 성공은 별개다. Reviewer의 class A/pass 모순, Planner 출력 스키마 위반도 받아들이지 않는다. 기존 command의 Artifact·Step 상태 조건이 바뀌면 수집을 거부하고 로컬 결과를 보존한다. Store 오류를 모델 실패로 기록하지 않는다.

관리형 실행은 한 Task에 한 번에 하나다. 이전 실행이 종료돼도 아직 수집되지 않았으면 다음 역할을 제출하지 않는다. 기존 기록 전용 submitRun과 수동 운영 입구는 유지한다.

## 식별과 설정 고정

Task ID + Run ID + 실행 UUID가 실행의 전체 식별자다. 발행 전 Intake는 같은 로컬 키의 소유자로 I-UUID를 사용하지만 공유 Run으로 가장하지 않는다. 실행 UUID는 Store 간 충돌도 피한다.

설정은 전역 defaults/역할/작업 유형 → 프로젝트 defaults/역할/작업 유형 → 확정 Step 역할 설정 → 명시 실행 입력 순으로 합친다. 제품 기본값은 fake이고 실제 CLI 모델은 지정한 때만 명시 모델로 기록한다. backend 전환은 상속 model/reasoning을 지우며, null은 backend 기본값을 의미한다.

명시 입력 digest와 실효 설정을 포함한 실행 입력 digest를 제출 시 고정한다. 재제출은 저장된 입력과 비교하고, 조회·수집은 기록된 backend로 어댑터를 선택한다. 이후 설정 변경은 기존 실행을 바꾸지 않는다. 명시한 backend가 기존 기록과 다르면 거부한다.

## 복구

제출은 로컬 prepare → 공유 submitRun → Runner 시작의 다단계다. 로컬 계획을 먼저, 준비 완료인 요청을 마지막에 게시한다. 공유 Run이 있는데 로컬 요청이 없으면 unknown이며 요청을 다시 만들지 않는다.

최초 시작 전에 영구 launch claim을 만든다. supervisor 또한 별도 claim으로 중복 시작을 막는다. launch claim 뒤 spawn/응답 전 중단은 unknown이며 시작을 반복하지 않는다. supervisor는 Task cwd를 붙잡지 않고 Node 실행 위치에서 동작하며, 역할 프로세스만 지정된 workspace에서 실행한다.

호출자가 종료돼도 supervisor는 역할 종료를 기다려 불변 결과를 게시한다. loopback 조회에서 실행 UUID를 확인하고, 응답이 없으면 종료 결과를 다시 읽는다. PID·stdout·출력 파일의 존재만으로 완료/실패를 추측하지 않는다. 옛 fake 준비 요청에서 backend와 launch.json이 없는 경우는 기존 호환 경로를 유지한다.

unknown이면 원래 머신·runner-dir, 기존 프로세스와 workspace 변경을 사람이 대조한다. launch claim이나 잠금을 삭제해 같은 Run을 다시 실행하지 않는다. 기존 실행이 더 쓰지 못함을 확인한 후에만 수동 실패 기록과 새 Run을 검토한다. 전원 장애·분산 실행의 보장은 하지 않는다.

## 역할과 읽기 실행

- Worker: Task worktree에서 write 실행. `workspace:code`는 Git 구현이 clean Task branch, 기준 commit ancestry, 실제 종료 HEAD를 검사한다. AI가 주장한 SHA를 채택하지 않는다.
- Planner: Task worktree에서 read 실행. JSON 출력은 planner-output으로 검증하고 recordDecision으로 기록한다. 다음 행동의 제안이 Task·Step의 자동 진행을 뜻하지 않는다.
- Reviewer: Task worktree에서 read 실행. 특정 Artifact 버전을 고정한 새 세션이다. Store의 문서 내용·작업 노트는 패킷에 넣고, 코드 Artifact는 HEAD·branch·clean 상태를 제출 때와 프로세스 시작 직전에 확인한다. 출력은 reviewer-output으로 검증하고 recordGate로 기록한다. deterministic 증거를 입력으로 받을 수 있지만 Runner가 해당 명령을 실행했다는 뜻은 아니다.
- Intake: Runner가 준비한 전용 빈 cwd에서 read 실행. 의도·정의 두 단계와 사람 확인은 별도 Intake 기록으로 관리한다. Task 발행 전 대상 repo 조회는 제공된 Context에 의존한다.

read 실행은 프로세스 시작 전후의 파일 내용을 비교한다. tracked/staged/unstaged/untracked/ignored 파일, HEAD와 index를 포함한다. symlink/junction이나 읽을 수 없는 파일로 검사할 수 없으면 거부한다. 위반 시 사용자 변경을 보존하고 invalidated로 기록한다. 이 검사는 시작·종료의 불변성을 확인하며, 중간에 변경했다가 되돌리는 행동이나 악의적인 하위 프로세스까지 감시하는 보장은 아니다.

CLI 수준의 제한도 함께 적용한다. Codex read는 read-only를 상속한 권한 프로필에서 출력 디렉터리만 쓰기를 허용한다. Claude Code는 읽기 도구와 지정 출력 쓰기만 제공한다. OpenCode는 read에서 출력 파일 외 edit를 거부한다. 시스템·관리자 정책은 우회하지 않는다.

## Context와 환경

Worker 재작업에는 Task/Step, 이전 Artifact·작업 노트, Gate·Feedback을 고정해 제공한다. 이전 코드 Artifact와 현재 HEAD/dirty 상태가 다르면 재작업 시작을 거부하고 현재 변경의 정리를 요구한다. Planner·Reviewer에도 Task/Step·관련 Artifact·Gate·Feedback을 제공한다. 이전 대화는 필요 없다.

이것은 최소 Context다. Ledger 자동 조립, 모든 입력 참조 해석, 변경 요구의 의미적 합성, 다른 repo 고정 checkout은 R03·R04·R08에 남아 있다. 누락된 자료는 packet_gaps로 보고한다.

공통 프롬프트는 역할 지침·출력 스키마와 참조 스키마·프로젝트 루트 AGENTS.md를 실행 계획에 고정한다. Claude Code는 safe-mode·프로젝트 설정 선택·MCP 제한·메모리 비활성화를 사용한다. bare 모드는 기존 로그인을 사용하지 못하므로 쓰지 않는다. Codex는 사용자 설정·rules·자동 프로젝트 문서 주입을 끄고 프로젝트 지침을 명시적으로 전달하며 메모리·apps를 제한한다. Windows에서는 사용자 설정 차단으로 sandbox 설정이 사라지지 않도록 `windows.sandbox="elevated"`를 명시한다. 인증 정보는 기존 CLI의 인증 경로를 사용하고 사용자 설정 파일을 수정하지 않는다. OpenCode는 기존 설정 영향을 받을 수 있으며 전체 사용자 환경 격리는 아직 검증하지 않았다. strict 격리 요청은 미지원 오류다.

옵션 근거: [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude 모델 설정](https://code.claude.com/docs/en/model-config), [Codex 설정](https://developers.openai.com/codex/config-reference/), [Codex Windows sandbox](https://developers.openai.com/codex/windows/windows-sandbox), [OpenCode CLI](https://opencode.ai/docs/cli/). 옵션·지원 범위는 어댑터와 테스트가 함께 관리한다. 모델 접근 권한이나 임의 버전의 지원을 보장하지 않는다.

## 취소, timeout, 메시지, 로그

취소 command는 사람의 요청을 먼저 기록한다. supervisor가 취소 또는 timeout을 감지하면 소유한 프로세스 트리에 종료를 요청하고 실제 종료 뒤에만 terminal 결과를 게시한다. Windows는 해당 child의 taskkill /T, POSIX는 실행용 프로세스 그룹을 사용한다. supervisor가 없으면 PID 추측으로 죽이지 않고 unknown을 유지한다. 실행 취소는 Task 전체 취소와 다르다.

Claude Code stream input만 live 메시지를 지원한다. command는 메시지 ID·원문을 먼저 이벤트에 기록하고 Runner에 전달한다. 같은 ID의 다른 텍스트는 거부한다. supervisor는 전달 직전에 로컬 claim을 만들고 stdin 쓰기 결과를 영수증으로 남긴다. claim 뒤 중단되면 재전송하지 않는다. 전달 성공은 stdin에 썼다는 뜻이며 모델의 이해·수용을 보장하지 않는다. Reviewer 개입은 거부한다. Codex/OpenCode는 live 메시지 미지원 오류를 반환한다.

원본 stdout/stderr, 통합 transcript, 정규화 이벤트를 실행 ID로 연결한 로컬 자료로 보관한다. 각 로그는 처음 8 MiB까지 보관하며 자동 삭제하지 않는다. log 조회는 byte offset과 nextOffset으로 제한된 범위를 읽는다. 원본 로그에 프롬프트·코드·경로가 있을 수 있어 공유 Store로 자동 복사하지 않는다. backend session ID와 실제 프로세스 종료 시각은 결과 수집 시 Run에 연결한다.

출력 자동 재시도는 기본 0, 설정해도 최대 2회다. 종료가 확인된 출력 위반만 대상으로 기존 잘못된 출력을 별도로 남기고 출력 수정 지시를 추가한 새 세션을 실행한다. unknown·프로세스 실패·read 위반은 재시도하지 않는다. resume는 사용자 결정에 따라 이번 범위 밖이며 네 backend 모두 supportsResume=false다.

## 검증 구분과 후속

대역 계약 테스트와 실제 CLI/모델 검증은 구별한다. 대역은 인자·입력·cwd·설정 고정·실패·취소·read 위반·재수집·복구를 검사한다. 실제 모델 smoke는 별도로 명시 실행하며 OpenCode 호출은 자동으로 포함하지 않는다.

2026-09-20에는 Windows / Node.js 22.15.1에서 `node tests/runner/real-smoke.mjs codex --reviewer`와 `node tests/runner/real-smoke.mjs claude-code --reviewer`를 실행했다. Codex 0.154.0(CLI 기본 모델)·Claude Code 2.1.278(sonnet 요청)이 각각 임시 repo에서 Worker 파일 생성 → 호출자 강제 종료 후 수집 → 문서 버전을 읽는 독립 Reviewer → Gate 기록을 통과했다. 실행 증거는 각 임시 root의 verification.json/reviewer-verification.json과 로컬 로그에 남긴다. 실제 모델의 코드 commit 검증·live 메시지·취소·출력 재시도까지 이 smoke로 검증했다고 주장하지 않는다. 해당 경로는 대역 계약 테스트로 검사한다.

역할별 HITL과 최소 `advance`는 ADR-0022에 따라 구현했다. 관리형 실행 계약을 질문 대화에 확장하지 않는다.

## 독립 질문 인계

`Runner.openQuestion`은 새 대화형 CLI에 질문과 고정 Context를 넘기고 터미널 실행 인계만 확인한다. `prepare/submit/inspect`, 관리형 Run ID, transcript 수집, 종료 감시, 취소나 답변 수집 경로를 사용하지 않는다. 질문 창이 열린 동안에도 `respondHitl`이 실행될 수 있다. 인계 결과 사건이 늦게 도착해도 Task/Step 진행 상태를 덮어쓰지 않는다.

backend/model/reasoning은 공통 설정의 question 선택자로 해석한다(ADR-0023). Runner 요청에 선택된 model/reasoning만 전달하며 권한이나 대화 timeout을 설정하는 경로는 없다. Codex의 관리형/질문 실행은 동일한 모델·추론 조합 검사를 공유하고 질문 CLI의 추론 설정도 어댑터 안에서 native 옵션으로 변환한다.

Windows/Codex **0.154.0**만 지원한다. 다른 버전·OS와 Claude Code/OpenCode/fake의 실제 질문 CLI는 미지원이다. Codex 대화형 명령에는 `exec` 전용 `--ignore-user-config/--ignore-rules`를 사용하지 않는다. 빈 native 설정 디렉터리에서 읽기 전용 sandbox, 승인 금지, 플러그인/앱/훅 비활성화, 기억 기능 차단을 적용한다. 사용자 인증 정보·설정·세션은 복사하지 않으므로 창 안에서 로그인 또는 sandbox 설정이 필요할 수 있다. 운영체제/관리자 제약은 우회하지 않는다.

질문 자료는 버전이 명시된 blob 원문과 SHA의 Git blob 바이트다. Artifact가 아직 없는 첫 Planner도 제출 당시 clean HEAD를 Run에 고정한다. 링크·submodule·크기 제한을 넘는 코드 스냅샷은 거부한다. worktree를 복사하지 않으며 새 worktree도 만들지 않는다. native CLI가 자기 인증/이력 자료를 저장하는 것과 devflow가 답변을 수집하는 것은 별개다. devflow는 native 디렉터리를 자동 삭제하거나 동기화하지 않는다.

검증은 구분한다. 단위/계약 테스트는 권한 인자, 격리 자료, 인계 실패, 질문과 승인 경합, Run/잠금 미등록을 검사한다. `node tests/runner/question-smoke.mjs`는 명시적으로 실제 Windows 콘솔을 잠깐 열어 TTY와 즉시 반환을 확인하고, 설치된 Codex sandbox에서 임시 질문 자료·Task 파일·Store 파일 쓰기가 모두 EPERM인지 검사한다. 2026-09-20 실측은 인계 약 0.5초, TTY 세 스트림 정상, 상속 MCP 0개, 쓰기 세 건 차단이었다. **이 smoke는 모델 호출이나 실제 사용자 질문 대화를 검사하지 않는다.** OpenCode 실제 연동 검증을 뜻하지도 않는다.

질문 AI 설정 추가 후 같은 smoke를 재실행해 model/reasoning 옵션이 포함된 대화형 인자를 설치된 CLI가 받아들이는지 확인했다. 인계 454 ms와 동일한 TTY/쓰기 차단 결과를 얻었다. 옵션 파싱 검증은 해당 모델의 실제 응답이나 계정 접근 권한 검증을 뜻하지 않는다.

## 시스템 deterministic 실행

Verifier는 AI Runner와 별도 인터페이스다. Task worktree·고정 HEAD·선언된 명령으로 요청을 준비하고 `@명령`을 설정 제공자로 해석한 실행 계획을 고정한다. 실행 기록이 없는 missing만 새로 준비하고, 불완전한 기록이나 영구 시작 표식 뒤 중단은 unknown이며 재시작하지 않는다. 종료 영수증만 수집한다. 실행 전후 HEAD/추적 상태가 바뀌면 실패로 기록하고 변경을 보존한다. 이미 끝난 실패는 worktree가 변경돼도 회수하며, 다음 Worker는 사람이 미수집 변경을 확인·정리한 뒤 시작한다. 검증 증거는 해당 Step/버전에만 적용하고 다음 Step에 상속하지 않는다.

명령마다 기본 300초, 이름으로 참조한 명령은 설정된 timeout을 사용한다. stdout/stderr는 검사당 최초 1 MiB까지 로컬 로그로 남기며 공유 결과에는 이름·종료 코드·기대 결과만 둔다. `expect: failure`는 timeout/프로세스 생성 실패를 제외한 명령의 nonzero 종료를 뜻하며, 실패 원인의 의미 판단은 별도 semantic 검증에 선언해야 한다. 의존성 setup과 프로젝트 exclusive 잠금은 아직 없으므로 해당 설정은 거부한다.
