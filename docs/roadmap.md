# Roadmap

이 문서는 **devflow의 구현 현황과 다음 작업 후보를 관리하는 단일 목록**이다. `devflow-data/backlog.md`의 미완료 항목·사용자 요구·설계 질문을 통합했다. 과거 실행의 사실은 [회고](retro/), 현재 구조는 [architecture.md](architecture.md), 결정 이유는 [ADR](adr/), 엔티티 필드의 기준은 `schemas/*.json`에 둔다. 로드맵의 후보는 구현 완료나 설계 결정 자체를 뜻하지 않는다.

## 새 세션에서 시작하는 법

1. `AGENTS.md`, 이 문서의 **현재 구현 수준 → 다음 작업 순서 → 선택한 항목**을 읽는다. 해당 ADR·설계·코드·테스트를 확인한다.
2. checkout, 사용자 변경, main과 PR 반영 여부를 다시 확인한다. 아래 기준점은 마지막 확인 시점이며 브랜치 이름만으로 반영 여부를 판단하지 않는다.
3. 후보 하나의 범위·완료 기준·선행 조건을 정한다. 여러 후보를 한 Task로 자동 합치거나, 미결정 제안을 정책으로 적용하지 않는다.
4. 완료 후 이 문서의 상태·검증 근거·남은 한계를 함께 갱신한다. 부분 완료는 항목을 지우지 말고 남은 범위를 적는다. 후속 후보에는 안정된 ID와 발견 출처를 남긴다.

상태는 **완료 / 부분 완료 / 미구현 / 미검증 / 미결정**으로 구분한다. 아래의 **사용자 방향**은 요청된 목표이며, **제안·미결정**은 구현 전에 판단할 선택지다. 기능 명세나 필드 설명을 여기서 새로 확정하지 않는다.

## 현재 구현 수준

### 기준점과 검증 범위 — 2026-09-20

| 묶음 | 구현 기준점 | 반영 상태 |
|---|---|---|
| Workspace 최소 기능 | `945ee1d9b80c6917b5263d93e5252d08022ea40e`, [PR #1](https://github.com/CheongMyungJ/devflow/pull/1) | main 병합 완료 |
| 복구 가능한 fake Worker | `46c0749d34c251fde7b3abe5064ce62bd0a3a951`, [PR #2](https://github.com/CheongMyungJ/devflow/pull/2) | main 병합 완료 |
| 세 실제 Worker 어댑터 | `b2cdab8c1e833245bfc3bb74688269d4c9f984af`, [PR #3](https://github.com/CheongMyungJ/devflow/pull/3) | main 병합 완료, merge commit `4239ab3428df8b8345c4606909d84182cebb6566` |
| 역할 설정·실행 | [PR #4](https://github.com/CheongMyungJ/devflow/pull/4) | main 병합 완료, merge commit `c5c1ae81765413d317efcd05e4e553b165ccb0d9` |

역할별 HITL 후속 작업은 PR #4의 병합과 clean main `c5c1ae8`을 확인하고 만든 `codex/role-hitl-question-cli`의 변경이다. 아래 PR #4 검증 이력과 이번 HITL 검증을 구별한다. 후속 브랜치의 병합 여부는 Git과 PR에서 다시 확인한다.

- **현재 검증:** Windows / Node.js 22.15.1, `npm run typecheck` 통과. 질문 backend 확장 후 `node node_modules/vitest/vitest.mjs run --testNamePattern '^(?!.*(?:opencode|OpenCode)).*$'`로 **54개 파일·722개 통과·18개 제외**. 사용자의 OpenCode 검증 제외 요청에 따라 해당 어댑터/입구 테스트를 건너뛰었다. 이전 전체 검사는 53개 파일·735개 통과였다. 현재 검사는 역할별 승인·수정·재검토, 중복/오래된 응답, 새 Artifact 버전, 질문/승인 경합, 시스템 검증·실패 회수·Step 간 증거 분리, 질문 AI 설정과 Claude 읽기 도구·인계 계약을 포함한다. Windows의 프로세스 기반 테스트 동시 실행은 4개로 제한했다.
- **실제 질문 콘솔/권한:** Codex **0.154.0**, 공통 인계 분리 후 재검사 **470 ms**, stdin/stdout/stderr TTY 정상, 질문 자료·Task·Store 표본 쓰기 3건 차단. model/reasoning 옵션을 포함한 대화형 CLI 인자도 확인했다. 재현은 `node tests/runner/question-smoke.mjs`다. Claude **2.1.278**은 질문 인자와 `--help`를 함께 실행해 옵션 파싱을 확인했다. **모델 호출이나 질문 대화 검증은 아니다**.
- **병합 기준 이력:** PR #3 기준 46개 파일·678개, PR #4 기준 49개 파일·707개 테스트가 통과했다. 실제 Git과 CLI 대역으로 종료 SHA, 입력/cwd/설정, 출력 위반·실패·취소·중복·unknown·호출자 종료 후 회수와 기존 변경 보존을 검사했다.
- **과거 실제 모델 검증:** Codex **0.154.0**·Claude Code **2.1.278**의 Worker를 각각 실행했고, PR #4에서는 각 Worker → 독립 Reviewer 흐름도 검증했다. 파일 생성, 문서 버전 전달, 호출자 종료 후 회수와 Gate 기록을 확인했다. 자동 테스트 수에는 포함하지 않으며 초기 실패를 성공 횟수로 세지 않는다.
- **미검증:** 실제 질문 모델 대화, OpenCode 실제 연동, 여러 실제 모델 역할을 연결한 전체 Orchestrator의 강제 종료/복구, 다른 OS·모든 모델/CLI 버전. 대역 검사나 콘솔 인계 성공으로 이 범위까지 완료했다고 판단하지 않는다.
- 재현 방법·CLI 호환성·실행 옵션의 근거는 [Runner 계약](design/runner.md), 새 운영 입구는 [역할 실행 사용법](execution-usage.md), 기존 입구는 [수동 운영 절차](stage0-manual-operation.md)를 따른다.

### 완료된 기반과 남은 경계

| 영역 | 상태 | 구현된 것 | 남은 경계 |
|---|---|---|---|
| 스키마·타입·역할 계약 | 부분 완료 | 스키마 로더, 생성 타입, Task 의도/2단계 Intake, 역할 출력·packet_gaps·수행 주체·참조 문법 | 잔여 의미 검사와 계약 정합은 R09·R10 |
| State Store | 완료 — 파일 기반 최소 계약 | 7종 엔티티, blob, ID/버전 발급, 불변 기록, append-only 이벤트, commit 식별자와 장애 복구 | 교차 Task 조회·운영/OS 확장·DB 중립성 실증은 R07·R11·4단계 |
| commands/queries·운영 입구 | 부분 완료 | 기존 실행 관리·Intake 발행, workflow 시작·advance·HITL 응답·질문, `npm run hitl` 메뉴 | 교차 Task 조회와 풍부한 검토 화면은 R07 |
| Workspace | 부분 완료 | 프로젝트 등록부 스키마/조회 시 검사, 머신별 clone/worktree 설정, Task worktree 준비·조회, 기준 SHA 고정, 단계 경계 복구 | 안전한 정리·base 이동·읽기 참조 checkout·의존성 준비는 R08 |
| 역할 Runner | 이번 합의 범위 구현 | 네 역할 신규 실행, read 사후검사와 CLI 제한, 취소/timeout, 출력 재시도, 메시지·로그·세션 ID, 기존 복구 계약 | resume와 제품 attach, 엄격한 OS/전체 환경 격리, OpenCode 실제 연동은 R02 후속 |
| 역할별 실행 설정 | 완료 — R01 및 질문 AI 확장 | 네 관리형 역할과 독립 question의 backend/model/reasoning, 전역·프로젝트·작업 유형·Step·명시 입력, 실효값/출처 고정, 미지원 옵션 거부 | 모델 품질·비용 정책과 접근 권한/CLI 전체 버전의 호환성은 별도 |
| Context·Ledger·검토 자료 | 부분 완료 | 제출 시 최소 Context 고정, Worker 이전 노트·Artifact·Gate·Feedback, Reviewer 문서 내용·코드 버전 확인 | 선언된 입력의 전체 해석·Feedback 우선순위·Ledger·후속 후보·사람용 렌더링은 R03·R04·R07 |
| Gate·Orchestrator | 부분 완료 — HITL 최소 루프 | 영속 cursor·실행 예약, 역할별 HITL, deterministic 명령/별칭 실행, semantic Reviewer, 최종 버전 승인 | setup/exclusive·Task 전체 중단·비용/횟수 상한은 R05·R06 |

**지금 할 수 있는 일:** Intake로 발행한 Task와 준비된 Workspace에서 opt-in workflow를 시작한다. Planner → Worker → 선언된 검증/Reviewer → 최종 Artifact 승인 → 다음 Planner를 `advance`로 연결하고 각 역할 HITL에서 승인하거나 새 세션에 수정 요청한다. 질문 CLI는 고정된 자료로 별도 창을 열고 즉시 인계한다. Planner done 수용은 완료 준비 상태까지이며 실제 Task 완료·merge/push는 별도다. 기존 개별 실행 입구도 유지한다.

**복구 경계:** 공유 `Run.status`는 수집 전까지 `submitted`, 실제 관찰 상태는 `execution.state`다. 종료 결과 없이 출력만 생긴 경우, 시작 표식만 남은 경우, supervisor 유실·로컬 기록 손상은 완료/실패로 추측하지 않고 `unknown`으로 둔다. 살아 있는 supervisor가 결과를 게시하면 같은 실행을 회수한다. 그렇지 않으면 사람이 기존 프로세스와 변경을 확인해야 한다. 시작 표식·잠금 삭제나 자동 대체 실행으로 덮지 않는다([ADR-0019](adr/0019-recoverable-worker-execution.md), [ADR-0020](adr/0020-local-cli-worker-adapters.md)).

### 단계 판단

수동 Task T-0001~T-0006, Workspace·Runner 기반과 역할별 HITL 최소 루프를 구현했다. **단계 전환의 공식 판단과 전체 MVP의 실제 업무 검증은 아직 남았다.** 자동 Ledger·전체 중단/완료 정책 등의 남은 범위는 아래 목록으로 관리한다. [T-0006 회고](retro/T-0006.md)의 과거 판단은 당시 기록으로 보존하며 현재 구현 상태로 다시 쓰지 않는다.

## 다음 작업 순서

역할별 HITL, 독립 질문 CLI와 질문 AI 설정은 구현했다. Codex·Claude Code·OpenCode 질문 어댑터를 연결했으며 OpenCode는 사용자 요청으로 공식 문서 기반 구현만 하고 실행 검증은 하지 않았다. 현재 계약은 [ADR-0022](adr/0022-role-hitl-and-independent-questions.md)·[ADR-0023](adr/0023-question-ai-settings.md)·[ADR-0024](adr/0024-question-backend-adapters.md), 운영 방법은 [사용법](execution-usage.md)에 있다. 다음 후보는 아래의 **남은 범위**이며, 이미 구현된 기능을 다시 개발하는 요청이나 새 Task 발행을 뜻하지 않는다.

| 순서 | 후보 | 남은 중심 과제 | 선행 조건·분리할 범위 |
|---|---|---|---|
| 완료 범위 | [R01 AI 설정](#r01), [R02 실행 기반](#r02), R03·R05~R07의 HITL 흐름 | 역할/질문 설정, 재제안·재작업·재검토, 검증과 버전 승인, 즉시 질문 인계 | 사용법·ADR을 기준으로 사용하고 남은 범위만 확장 |
| 1 | [R03 Context·재작업](#r03) | 요구 변경의 우선순위·carry-over·입력 참조 해석 | 기록 전달은 구현됨. 실효 요구사항 합성과 외부 자료 준비를 구분 |
| 2 | [R04 Ledger·후속 후보](#r04), [R07 검토 자료](#r07) | 자동 Ledger와 사람이 읽기 쉬운 diff·검토 자료 | 원본 기록을 대체하지 않는 생성 계약. GitHub 발행은 뒤로 |
| 3 | [R05 Gate](#r05), [R06 advance](#r06), [R13 실제 적용](#r13) | setup/exclusive·전체 취소·상한과 실제 업무 검증 | 각각 범위를 정해 확장. 질문 모델 대화 검증도 아직 남음 |
| 병행 후보 | [R08 Workspace](#r08)·[R09 계약 정합](#r09)·[R10 지침](#r10)·[R11 운영 검증](#r11) | 선택한 기능을 실제로 막는 항목 또는 독립적인 작은 결함 | 잔여 스키마 전부를 먼저 한 묶음으로 고치지는 않음 |

## 1단계 — MVP의 남은 작업

범위는 사용자 1명, Task당 대상 repo/worktree 1개, 여러 프로젝트·Task, Task 안의 순차 Step, 작은 버그 수정·소규모 기능이다. Skill 없이도 한 바퀴를 수행해야 한다. 각 R 항목은 작업 묶음이므로 한 Task보다 클 수 있다.

<a id="r01"></a>
### R01. 역할과 질문 AI의 backend·model·추론 수준 설정

**상태: 구현 완료 — 네 관리형 역할은 PR #4 병합, 질문 AI 확장은 현재 후속 브랜치.** 출처: T-0004 설정 요청, ADR-0010, 2026-09-20 사용자 재확인. 결정: [ADR-0021](adr/0021-role-settings-and-managed-execution.md)·[ADR-0023](adr/0023-question-ai-settings.md).

- **HITL 후속 사용자 요청 반영:** 질문 AI도 `roles.question`으로 같은 계층에서 독립 설정한다([ADR-0023](adr/0023-question-ai-settings.md)). backend/model/reasoning의 실효값과 출처를 인계 전에 기록한다. 대상 Run 모델을 자동 상속하지 않으며 대화 수명·권한 정책은 설정 대상으로 추가하지 않았다.

- **구현:** Worker·Reviewer·Planner·Intake·question의 설정 스키마·조회·실효값 해석과 실행 연결. 전역 파일은 명시적 `--config` 또는 `DEVFLOW_CONFIG`, 프로젝트는 worktree의 `.devflow.yaml`의 execution이다. 머신별 Workspace 경로 설정과는 분리한다.
- **확정 순서:** 제품 기본값 → 전역 defaults/역할/작업 유형 → 프로젝트 defaults/역할/작업 유형 → 확정 Step 역할 설정 → 명시 실행 입력. Step의 task_type이 있으면 Task type보다 우선한다. backend 변경 시 상속 model/reasoning은 해제하고 null은 backend 기본값으로 되돌린다.
- 백엔드별 추론 수준은 지원 범위와 의미가 다를 수 있다. 로컬 CLI 도움말·공식 자료를 확인해 어댑터가 변환/검사한다. 미지원 값을 조용히 무시하지 않는다. 인증·사용자 전역 CLI 설정을 자동 변경하지 않는다.
- **검증:** 역할/질문의 우선순위, backend 변경·null 초기화, 미확정 Step 제외, native model/reasoning 인자, 기존 Worker 호환과 인계 후 설정 불변성을 검사했다. 관리형 실행은 실효값/출처와 입력 digest, 질문은 초기 사건에 실효값/출처를 기록한다. OpenCode reasoning과 실제 질문 대화는 미검증이며 모든 모델·계정의 접근 가능성을 보장하지 않는다.
- Reviewer 사용 여부·깊이, 재작업 시 상위 모델로 변경하는 규칙은 [R06](#r06)의 정책 질문이다. 모델별 품질·비용 우열은 [R13](#r13)의 비교 없이 단정하지 않는다.

<a id="r02"></a>
### R02. 다른 역할 실행과 Runner의 나머지 기능

**상태: 이번 합의 범위 완료 / 후속 범위 남음.** 신규 Worker/write의 복구 계약을 유지한다([Runner](design/runner.md), ADR-0010·0019·0020·0021).

- **구현:** Planner·Reviewer는 Task worktree의 신규 read 실행이며, 출력 수집은 기존 Decision/Gate 기록에 연결한다. Reviewer는 특정 Artifact 버전과 문서 원문을 받고, 코드 Artifact의 HEAD·branch·clean 상태는 제출과 실제 시작 시 검사한다. Intake는 빈 전용 cwd와 별도의 버전 기록으로 의도 확인 → 정의 확인 → Task 발행을 수행한다.
- read 실행은 ignored 파일을 포함한 내용·Git HEAD·index를 시작/종료에 비교하고 변경을 발견하면 invalidated로 수집한다. 변경을 reset/삭제하지 않는다. symlink/junction은 검증 불가로 거부한다. 작업 종료 후 원상복구한 일시적 쓰기나 악의적 프로세스까지 막는 OS 격리는 아니다.
- 역할 지침·프로젝트 AGENTS.md를 고정해 전달한다. Claude safe-mode와 Codex 사용자 설정/rules/메모리/apps 제한을 적용한다. Codex Windows는 sandbox를 명시한다. 관리자 정책은 유지하며, OpenCode의 전체 환경 격리는 미검증이다. strict 요청은 거부한다.
- 취소 의도 기록 → supervisor 종료 요청 → 종료 영수증 → 수집을 구현했다. timeout도 종료를 확인한 실패로 구분한다. Task마다 수집 전 관리형 실행은 하나로 제한한다. 로그/정규화 이벤트·backend session ID·실제 종료 시각과 수집 시각을 연결한다.
- 출력 재시도는 기본 0, 명시한 제한 안에서 종료된 출력 위반에만 적용한다. 로그는 각각 최초 8 MiB 보관, 자동 삭제/공유 Store 복사 없음이다. Claude live 메시지는 이벤트 기록 뒤 ID로 중복을 막아 전달한다. stdin 전달 성공과 모델이 읽은 사실은 구별한다. Reviewer 개입과 Codex/OpenCode live 입력은 미지원이다.
- **사용자 결정:** resume는 이번 구현에서 제외했다. 모든 역할은 새 세션이며, 불명확한 기존 실행을 자동 대체하지 않는다. 독립 질문은 이번 HITL 흐름에서 제공하며 자체 대화 화면을 만들지 않는다. **후속:** 관리형 실행 관찰 화면, 로그 보관 정책의 운영 확장, 하위 세션의 모델·토큰·출처 추적, 엄격한 환경 격리와 OpenCode 실제 연동.
- **완료 기준:** 역할별 계약·read 위반·지원 capability·실패/취소/복구 테스트와 기록 일관성. 대역/실제 CLI/실제 모델 검증을 나누어 보고한다. OpenCode 실제 연동은 현재 미검증 상태로 유지하며 별도 범위가 정해지기 전 자동 실행하지 않는다.

<a id="r03"></a>
### R03. Context·Feedback·재작업 입력 계약

**상태: 부분 완료 — 역할별 재작업 패킷 구현.** 출처: T-0002 Feedback 우선순위, T-0004/5 packet_gaps, T-0006 재작업 운영, ADR-0001·0008·0010·0012·0021·0022. Planner Decision/이전 제안, 사람 수정 요청, Worker 이전 노트·Artifact·Gate·Feedback과 Reviewer 버전·문서 원문을 새 세션에 전달한다. AC 변경 우선순위·carry-over·다른 repo 참조 등은 남았다.

- **구현:** Task/Step·Decision·Artifact 원문·Gate·Feedback·이전 노트를 자동 조립하고 제출 시 패킷 blob으로 고정한다. 질문은 문서 버전과 Git SHA의 자료를 사용하며 첫 Planner의 코드도 제출 당시 HEAD에 고정한다. 자동 Ledger와 선언된 입력 참조 전체의 해석은 남았다.
- Feedback이 AC/done_when을 바꿨을 때 실효 정의·이력·우선순위를 정한다. “승인하되 다음 Step에서 반드시 수정”을 사람이 쓴 문장에만 두지 않고 전달·이행 여부를 확인할 계약을 정한다.
- **구현:** 재작업은 같은 Workspace에서 새 세션·새 Artifact 버전을 만들며 코드 버전의 HEAD/clean 상태를 검사한다. 이전 결과·노트·Feedback·Gate를 전달하고 새 버전을 다시 검증한다. 지적사항별 carry-over와 이행 확인의 정식 계약은 남았다.
- 다른 프로젝트의 `code://`는 등록부의 고정 SHA 읽기 참조로 제공한다. 로컬 checkout 경로는 구현 경계 안에서 해석한다. 준비는 R08과 연결한다.
- Planner HITL 수정은 이전 제안을 취소 상태로 남기고 새 Decision에 대체 관계를 기록한다. 개별 실행의 `define-step --edited`와 구분하며 workflow에서는 HITL 입구로 응답한다.
- **완료 기준:** 새 세션이 이전 대화 없이 필요한 증거를 찾고, 재작업 시작 버전·요구 변경·carry-over가 누락되지 않는 계약 테스트와 작은 실제 흐름. Context에 무엇이 들어갔는지 원문/출처를 확인할 수 있어야 한다.

<a id="r04"></a>
### R04. Ledger 자동 작성과 후속 후보의 지속적인 기록

**상태: 미결정·미구현.** 출처: T-0005/6 사용자 요구, ADR-0001. 최소 HITL advance는 원본 기록을 직접 전달하며, 전체 MVP의 자동 Ledger 계약은 남았다.

- **사용자 방향:** 사람 손 없이 필요한 기록이 빠짐없이 Ledger에 남고, Task에서 나온 후속 조치가 Task 밖의 후보로 이어져야 한다. 후보 우선순위·정리는 사람의 일이며 지금 범용 이슈 엔티티를 만들지는 않는다.
- **미결정:** 승인된 출력·Gate·Feedback·Decision에서 결정론적으로 조립 / 별도 AI 요약 역할 / Planner가 기록 재료를 출력. 역할이 Ledger를 직접 쓰는 방식으로 결정된 적은 없다.
- 다음 Step 전달사항, 상세 증거의 참조, 승인된 버전·검증·결정·변경된 요구·미확인 사항·후속 조치를 보존한다. 승인된 사실과 아직 열린 질문/미승인 제안을 구별하고 반영 시점을 정한다. Ledger는 원본 증거를 대체하지 않는다.
- 후보 추출 대상: Gate의 B 지적, 작업 노트의 미확인 사항, packet_gaps, 회고 개선 조치, Planner done에 딸린 후속. 추출 주체·시점·형식·목적지와 Task/Gate/Run 출처를 정한다. 프로젝트별 파일 또는 트래커로 내보낼 수 있는 경계를 검토한다.
- **완료 기준:** T-0001~T-0006 Ledger에서 다음 판단에 쓰인 재료를 대조하고, 중단/재수집 시 누락·중복 없이 Ledger와 후속 후보가 남는 최소 흐름을 검증한다.
- 후보에서 Intake 초안을 만들고 발행 Task에 연결하는 **들어오는 흐름**은 후속이다. 한 후보의 분할·부분 처리·여러 Task, 사람이 직접 시작한 Task와의 동일한 처리 규칙도 그때 정한다. 현재 이 로드맵 통합은 자동 후보 관리 기능의 구현이 아니다.

<a id="r05"></a>
### R05. Gate 실행과 판정 계약

**상태: 부분 완료 — 시스템 deterministic 실행과 semantic Reviewer 연결.** 출처: ADR-0003·0004·0017·0022, T-0003 deterministic 작성 주체, T-0006 G-006/F-008/R-018. 명령/프로젝트 `@별칭`, timeout·exit·로그, 고정 HEAD/clean 검사, 시스템 증거 합성을 구현했다. setup/exclusive는 명시적으로 거부하며 다른 repo 검증 스크립트 준비는 남았다.

- **구현:** 별도 시스템 Verifier가 Task worktree에서 deterministic 명령을 실행하고, 선언된 semantic 검증만 새 Reviewer로 연결한다. 시스템 증거를 Gate에 합성하며 검증 증거를 다른 Step에 상속하지 않는다. check 실패/누락 또는 unmet done_when을 pass로 기록하는 Reviewer 결과는 거부한다.
- **구현:** Reviewer 판정은 HITL 수용 전 checking에서 기다린다. fail 수용은 Worker 재작업으로 연결하고, 판단 재검토는 같은 버전의 새 Gate를 만든다. deterministic 실패도 재작업으로 가며 검증이 남긴 파일 변경은 사람 확인 전 보존한다.
- **남은 범위:** 프로젝트 setup·exclusive Gate 직렬화, 다른 repo 검증 스크립트의 고정 SHA 참조와 준비, 더 읽기 쉬운 검증 증거 표시.
- **검증:** 실제 명령의 통과/실패/기대 실패, 실행 반복 방지, unknown 보존, worktree 변경 무효화와 실패 회수, 새 버전 재검증을 검사했다. 후속 기능은 이 보장을 유지하는 테스트를 추가한다.

<a id="r06"></a>
### R06. 멱등 advance와 사람의 결정·취소 정책

**상태: 부분 완료 — 역할 HITL 최소 advance 구현.** 영속 실행 예약·cursor·대기 대상, 같은 응답 재조회와 오래된 응답 거부, Gate fail 재작업, 동일 버전 재검토, 다음 Step 연결을 구현했다. 기존 commands와 상태 전이를 재사용한다. 전체 취소·상한·Ledger·Planner의 ask_human/rework/abort/Skill 확장 실행은 후속이며 현재 해당 제안 수용은 사유를 남기고 일시 정지한다.

- **구현:** 외부 실행 전 영속 예약, HITL 대상 전체 대조와 동일 응답 재조회, 결과 수집 뒤 중단 복구를 제공한다. 관리형 Run 취소와 Intake 완료·발행도 기존 기능으로 유지한다.
- **남은 범위:** Step/Task 전체 중단, 종료가 확인된 실패 이후 재개 정책, 재작업·Step 수·비용 상한, Event 종류별 data 스키마(F5).
- 역할을 생략하거나 사람이/조율 세션이 직접 수정했으면 실제 수행 주체·이유·검사 범위를 기록한다. 수행하지 않은 Planner/Reviewer/Gate를 수행한 것처럼 쓰지 않는다.
- **확정 정책:** 역할별 HITL은 기본 켜짐이며 시작 설정으로 각각 생략할 수 있다. Worker 수용은 검증 시작만 허용하며 최종 Artifact 승인과 다르다. verify 최소 하나, deterministic이 없으면 approval required, 특정 Artifact 버전 승인 규칙을 유지한다. **미결정:** Planner 판단에 따른 동적 승인 정책, 작업 유형별 검토 깊이·재작업 시 모델 변경. `verify: none`이나 일괄 우회는 채택하지 않았다.
- **미결정 제안:** Intake에 검토를 집중, Planner가 새로 정한 것이 있을 때 Step 확인, Worker 시작 직후 가정 확인, 작은 Task의 빠른 경로·Skill로 뻔한 Step 생략. 기존 고정 흐름을 이미 대체했다고 보지 않는다. Reviewer 판정의 독립성도 유지한다.
- Planner done 수용은 Decision을 가리키는 Feedback과 HITL 사건으로 남긴다. 실제 Task 완료의 증거 검사와 원래 success_criteria·결과·한계 대조는 별도이며 AC 번역만으로 완료를 판단하지 않는다.
- merge/push/문서/후속 이관 등 done 이후 절차와 실행 권한을 구분한다. main 검증 실패 시 재개/추가 승인/Task branch 관계를 정한다. 완료가 자동 merge·push 권한을 뜻하지 않는다.
- **검증과 남은 범위:** 역할별 성공·수정·Gate 실패 재작업·질문/승인 경합·오래된 응답·unknown 회수·다음 Step을 계약 테스트로 검사했다. 실제 모델을 연결한 전체 흐름의 강제 종료/복구와 Task 전체 취소는 별도 검증이 필요하다.

<a id="r07"></a>
### R07. 제품 CLI와 사람이 읽을 검토 자료

**상태: 부분 완료 — HITL 메뉴와 구조화된 검토 자료.** 출처: T-0005 검토 요청, Store 3.9, 기존 MVP 계획, ADR-0022. `npm run hitl`에서 역할 결과·버전과 승인/수정/질문 선택을 제공한다. 풍부한 diff/요약과 교차 Task 화면은 후속이다.

- **구현:** `execution` JSON/YAML 입구와 `hitl` 메뉴가 commands/queries만 호출한다. 역할 결과·버전·승인/수정 선택과 독립 질문 인계를 제공하고 구조 테스트로 경계를 검사한다. 통합 `task ...` 명령 체계와 관리형 실행 관찰 화면은 후속이다.
- Task 전체의 “내 입력 대기” 조회, 진행 중 Store commit의 읽기 대기/StoreBusyError 안내를 만든다. 교차 Task 조회와 lock 안 읽기가 필요하면 Store 인터페이스의 확장안을 실제 사용 사례로 검증한다.
- 검토에 필요한 내용은 무엇이 바뀌었는지, 사람이 정할 것과 선택지/권고/책임, 미확인·남는 한계, 상세 근거다. 원래 성공 기준과의 대조, 재작업 이유/시작 버전/전체 재검토, 생략한 검증도 보여 준다.
- **질문 지원 경계:** Windows/Codex 0.154.0·Claude Code 2.1.278·OpenCode 1.x 어댑터, 고정 버전/SHA, 별도 native 설정과 읽기 전용 옵션을 사용한다. OpenCode는 공식 가이드 기반으로만 구현했고 설치·실행·권한 동작 검증은 하지 않았다. 실행 인계 뒤 즉시 복귀하며 대화·종료·답변을 관리하지 않는다. 별도 로그인/초기 설정이 필요할 수 있다. AI 설정은 R01, 책임 범위는 ADR-0022/0024에 있다. 다른 환경과 실제 모델 대화 검증은 후속이다.
- **미결정:** decisions_needed·newly_decided·성공 기준별 결과 등 정식 출력 재료, 결정론적 렌더링에 출처 있는 AI 요약을 덧붙일지. 현재 대화 Orchestrator가 파일들을 읽고 설명하는 일을 결정론적 시스템이 저절로 할 수 있다고 가정하지 않는다.
- **완료 기준:** AI가 요약을 다시 쓰지 않아도 사람이 승인 대상 버전·검사 실패·결정할 내용·한계를 확인하고 응답할 수 있는 최소 화면/텍스트 예제와 테스트. 같은 재료는 R12 발행에 재사용한다.

<a id="r08"></a>
### R08. Workspace와 데이터 repo의 운영 후속

**상태: 부분 완료.** 기준: [Workspace 설계](design/workspace.md), ADR-0018.

- base branch 이동을 탐지해 Planner에 전달한다. 이미 준비된 Task 기준 SHA와 사용자의 commit·staged/unstaged/untracked 변경을 보존한다.
- 다른 repo의 고정 SHA 읽기 checkout, 의존성/빌드 환경 준비와 임시 실험의 소유권을 정한다. node_modules junction 등이 원래 Workspace의 캐시를 바꾸는 부작용을 막는다.
- 정리의 소유권·대상·시점·실패 보고를 정한 뒤 안전한 cleanup을 추가한다. 현재 Git 생성 도중의 불완전 상태·기존 lock/시작 표식·알 수 없는 worktree는 수동 확인한다. 삭제 거부를 우회하거나 자동 reset하지 않는다.
- Step 전이별 데이터 repo Git commit과 repo 단위 직렬화를 구현한다. Task별 Store commit 직렬화와 Task ID 발급은 이미 구현됐으며 데이터 repo의 Git commit 직렬화와 별개다.
- **완료 기준:** 기존 Workspace 변경 보존, base 이동/부분 준비/정리 실패의 관찰, 여러 Task의 데이터 commit 충돌 처리. 운영 기록을 시험 데이터로 직접 변경하지 않는다.

<a id="r09"></a>
### R09. 남은 스키마·명령 계약 정합

**상태: 부분 완료.** 작은 독립 후보 또는 해당 기능을 막을 때 함께 처리한다. 기존 기록 호환성을 확인하고 생성 타입은 commit하지 않는다.

| ID | 남은 일 | 출처·현재 구분 |
|---|---|---|
| R09-1 | `code_change` 전체 diff에 paths 없이 `stored_in: repo`를 쓸 수 있는 계약 정합 | T-0006 G-003/004 B, F-006. 현재 completeRun은 이 경우 stored_in 생략. `workspace:code`의 SHA 검증 완료와 별개 |
| R09-2 | Gate/Feedback Artifact 참조와 Event ref의 스키마 pattern, Event commit_id 설명의 옛 운영 문구 | T-0006 G-001/002. command 입구 검사는 완료, 수동 파일의 validate-data 검사·기존 기록 호환은 남음 |
| R09-3 | Decision 원래 Step 제안과 사람 수정 후 실효 Step의 의미(F2), 신규 Planner 출력의 packet_gaps 필수화 방식 | next_step.step 내부 `$ref` 검사는 완료. 옛 Decision 호환과 새 출력 엄격함을 구별 |
| R09-4 | reviewer-output/gate-result의 class A→fail 집행 주체 설명, annotations 생략/빈 배열 설명 | T-0003 G-004. 역할 지침뿐 아니라 command도 A→fail을 검사함 |
| R09-5 | success_criteria/open_questions ID 중복, 없는 covers, 누락된 성공 기준, 빈 성공 기준의 의미 검사 | T-0004 G-001/002. Intake 수동 되짚기는 있으나 createTask의 의미 검사는 없음. 검사 위치와 옛 양식 호환을 결정 |
| R09-6 | 등록부 검사 적용 시점과 누락 경로 | projects.yaml 스키마·FileProjectCatalog 검사는 완료. validate-data의 등록부 검사와 base_branch를 명시한 createTask의 미등록 repo 거부는 아직 보장하지 않음 |
| R09-7 | AC 검증 시점(Task branch/main), completion evidence의 Artifact/코드 참조 형식 | T-0002 이후. Intake의 Task branch 안내는 있음. 고정 기준 없이 계속 자라는 테스트/레코드 수를 완료 기준으로 삼지 않음 |

Event 종류별 data(F5)는 R06, Feedback 요구 변경/carry-over/입력 참조는 R03, Task done 확인(F4/F7)은 R06에서 다룬다. 엔티티의 필드 설명은 이 목록이 아닌 스키마 description에서 고친다.

<a id="r10"></a>
### R10. 역할 지침과 문서의 잔여 정합

**상태: 부분 완료.** 이미 완료된 T-0003~T-0006 출력 수용을 다시 미검증으로 돌리지 않는다. 지침을 더하는 일과 실제 역할이 따르는지 검증하는 일을 구별한다.

- Worker 작업 노트를 commit 직후부터 남기고 확인 결과를 덧붙이는 지침, 범위 밖 유사 문제를 고치지 않고 기록하는 지침. 설계 실험의 초안 원문도 산출물/작업 노트에 남겨 Reviewer가 재구성하지 않게 한다.
- Planner의 스키마 변경 검증에는 생성 타입 실제 사용, 프롬프트 변경에는 새 세션 출력의 실제 수용을 포함할지 정한다. 검증 지시끼리 충돌하지 않게 하고 실험 횟수·실패 뒤 진행 범위를 명확히 한다. 유형별 규칙이 커지면 2단계 Skill로 옮긴다.
- `roles/README.md`의 JSON 공통 설명과 Planner YAML 입구의 정합을 맞춘다. Worker JSON 보고와 작업 노트의 역할은 T-0006 입구에서 분리됐으므로 옛 불일치를 전부 재현된 문제로 취급하지 않는다.
- **사용자 결정(T-0004 F-004): Intake 개선은 재발 관찰부터.** constraints/non_goals 중복, 의도 확인 뒤 성공 기준 변경 시 재확인, AC→성공 기준 역방향 대조, 유보 결정과 non-goal 구별, 질문의 선택지/권고/책임을 다음 실제 Intake에서 관찰한다.
- 연구형 Intake, 의미가 어긋난 입력 탐지, non_goals→scope.exclude, 맡겨진 질문 ID의 전달, Reviewer의 Step/Task 기준 충돌은 별도 행동 검증이 남았다. 출력 스키마 통과만으로 이 행동까지 검증됐다고 하지 않는다.
- 구조 변경 시 새 ADR이라는 규칙은 현재 AGENTS.md에 있다. ADR 작성 시점(설계/구현 뒤), 새 ADR의 merge 전 교정 범위, ADR-0017의 issue-task 인자 예외 설명은 남은 문서 정합 후보다. 이미 수용된 ADR을 편의로 다시 쓰지 않는다.
- **완료 기준:** 관련 회고를 근거로 최소 지침을 고치고 실제 소비자/역할이 따르는지 확인한다. roles 문서에 특정 도구 기능·tool 이름을 넣지 않는다.

<a id="r11"></a>
### R11. 운영 도구와 검증 사각지대

**상태: 부분 완료 / 일부는 낮은 우선순위의 관찰 후보.** 실패를 새로 재현하지 못한 항목은 원인 확정으로 쓰지 않는다.

- `check-gitignore`: 현재 기존 HEAD가 있는 데이터 repo 루트를 보장한다. 하위 폴더·첫 commit 전 staged .gitignore에 대한 지원 확대 또는 명시적 오류 안내를 정한다(T-0006 G-006 C). 실제 내부 파일의 tmp/reap/pending 세부 모양 검사도 보강 후보다.
- Store가 직접 쓰지 않은 대소문자만 다른 일부 엔티티 파일은 NTFS의 get/list 결과가 다를 수 있다(T-0005 G-004 B, F-007). 사람이 직접 두지 않는 전제로 수용했던 한계다. 문서화 또는 읽기 철자 검사 확대를 선택한다.
- store.md 2.6의 `(mtime, size)` 캐시 제안은 과거 관찰과 맞춰 재검토한다. 다만 과거의 “confirmOutcome 뒤 엔티티를 비교해야 한다/가짜 Store로만 검사했다”는 주장은 현재 과제가 아니다. commit_id 기반 확인과 실제 FileStore 장애 주입 테스트가 이미 있다(ADR-0015, `tests/commands/outcome.test.ts`).
- build·mjs 복사 코드가 `tests/global-setup.ts`, `scripts/check-store-read.mjs`, `scripts/lib/build.mjs`에 나뉜 것을 정리할지 검토한다. merge 뒤 Windows 캐시 rename의 제한적 재시도는 `e01264c`에서 해결됐으나 당시 외부 잠금 주체는 미확인이다.
- macOS/Linux, 파일 시스템의 대소문자 차이, 큰 blob의 lock 시간, ID 발급 공정성, ajv 이외 검증기·타입 생성기 버전은 미검증이다. 지원한다고 주장하기 전에 환경별 범위를 정해 검사한다.
- Worker 실행 중 호출자 강제 종료/복구는 완료됐다. HITL 최소 루프의 역할 연결·unknown 회수·경합 응답·질문 인계 중 승인은 계약 테스트로 검사했다. 여러 실제 모델 역할을 연결한 전체 Orchestrator의 강제 종료·실행 중 사람 개입은 아직 미검증이다. 전원 장애·분산 실행의 보장을 추정하지 않는다.
- **완료 기준:** 고른 위험의 재현·지원 범위·오류 안내 또는 명시된 한계가 남는다. 문서상의 모든 가능성을 한 Task의 테스트 목록으로 확대하지 않는다.

<a id="r12"></a>
### R12. 프로젝트 GitHub 이슈로 작업 기록 발행

**상태: 사용자 방향 확정 / 구현 미착수.** R07의 읽기 쉬운 렌더링 뒤에 진행한다. 출처: T-0005 사용자 제안·결정.

- 프로젝트별 사용 여부와 목적지를 설정하고, Task 발행·Step 한 라운드의 승인까지·Task done 때 사람이 볼 가치가 있는 기록을 한 방향으로 게시한다. 기준 기록은 State Store이며 이슈는 사본이다.
- **사용자 결정:** 게시 한 번 시도 후 넘어간다. 게시 결과 검증·재시도·중복 방지 보장·사람이 수정한 코멘트 대조를 요구하지 않는다. 이슈 댓글을 Feedback으로 받아들이지 않는다. 게시 실패가 본 작업을 막지 않게 한다.
- **미결정:** 공개 repo로 보낼 내용의 공개 범위, 개인/비공개 기록 처리, 목적지와 실패 보고. `onCommitted` 뒤의 발행기와 트래커 어댑터는 구현 제안이며 결정된 위치가 아니다.
- **완료 기준:** opt-in 설정, 정해진 세 시점의 렌더링/게시, 실패 시 본 흐름 지속을 테스트한다. 4단계의 양방향 PR/이슈 연동과 구분한다.

<a id="r13"></a>
### R13. 실제 업무 적용과 효과 검증

**상태: 미검증 — 비교 효과 / 부분 완료 — 수동 운영 경험.** 전체 MVP의 단계 판단에 사용한다.

- devflow 자체를 넘어 실제 업무 repo 1개에 적용하고 10~20개 Task의 결과를 남긴다. Workspace·Runner 기술 검증 횟수를 완결된 업무 Task 수로 세지 않는다.
- 관찰할 핵심: Planner가 검증 가능한 크기로 Step을 나누는가, 새 세션 Context가 충분한가, 사람이 읽고 결정하는 부담이 줄었는가, 미확인/후속 조치가 빠지지 않는가.
- 독립 검토가 결함을 찾고 기록으로 인계한 경험은 있지만, “한 세션 + 마지막 새 Reviewer”보다 이 시스템이 유용한지는 입증되지 않았다. 같은 종류의 작업에서 사람 시간·벽시계·토큰·뒤늦게 발견한 결함을 비교한다. 사람 시간 감소를 단계 기준에 넣을지는 미결정이다.
- 모델·백엔드·resume의 효과는 작업 크기가 다른 소수 사례로 결론내리지 않는다. 수동 Codex Reviewer 사용 경험은 제품의 Reviewer Runner 완료를 뜻하지 않는다.

## 이후 단계와 넘어가는 기준

단계 번호는 기술 기능의 존재만으로 자동 승격하지 않는다. 회고와 실제 업무 증거로 판단한다.

| 단계 | 목표·남은 범위 | 넘어가는 기준 |
|---|---|---|
| 0 — 수동 조율 | T-0001~T-0006 완료. 스키마/출력/Store/기록 command를 실제 운영에서 다듬음 | Task 2~3개는 충족. 스키마 변경이 잦아들었는지는 아직 공식 판단 필요 |
| 1 — 얇은 MVP | HITL 최소 루프 구현. R03~R13의 잔여 운영 기능과 실제 업무 적용 | 실제 Task 10~20개 수행 기준은 아직 미충족 |
| 2 — 안정화 | 반복 패턴의 Skill 추출·버전, Ledger 품질, 재작업/비용 상한 조정, 실패 기반 프롬프트 개선·버전 태그, 모델/세션 경로별 재작업률 비교, OpenCode 실제 연동 검증, events 기반 회고 초안 | 기존 계획: 최근 10개 Task의 Planner 제안 수정률 10% 미만이면 auto-plan 기본 전환 검토. R06 정책과 사람의 결정을 거치며 수치만으로 자동 승인 생략하지 않음 |
| 3 — 업무 확장 | 연구/가설 실험·복잡한 불량 분석, 큰 기능의 하위 Task, 저위험 approval optional 확대, 실행 중 개입의 Step/Task 분류, 대상 repo 확대, R04 후보→Intake 흐름 | 여러 Task 유형에서 안정 동작. Task 수로 조회가 느려지거나 팀 사용이 필요해짐 |
| 4 — 시스템 확장 | HTTP commands/queries, DB+object storage, queue/컨테이너/서버 Workspace/credential, 이벤트 기반 advance·알림, 웹 UI·다중 사용자·권한·낙관적 잠금, 양방향 PR/이슈/CI 연동, 독립 Step 병렬화 | 실제 규모·운영 요구에 맞춰 별도 수립 |

4단계 전 확인할 것: Store 중립성은 다른 구현으로 입증되지 않았다. 메모리/SQLite 등의 대체 구현에 공통 계약 테스트를 적용하고, 저장값 정규화와 commit 결과 확인, 모든 scope의 taskId 의존·교차 Task 조회 비용을 검증한다. Git이 제공하던 감사/백업·직접 YAML/Ledger 열람을 DB의 UI/export로 어떻게 대신할지, Ledger를 blob/생성 뷰 중 무엇으로 둘지, 이벤트와 엔티티/blob의 이전을 어떻게 검증할지도 정해야 한다.

**의도적으로 뒤로 미루는 것:** Step DAG·병렬 실행, Skill 레지스트리, 범용 멀티 에이전트 협업, 범용 플러그인 체계. 현재 하위 세션의 관찰 필요가 이 전체 체계의 구현 요청을 뜻하지 않는다.

## 통합 출처와 정리 기준

2026-09-20에 `devflow-data/backlog.md`(통합 전 commit `182f15315e44f5b57569e8e07466b921872012a5`)와 기존 로드맵을 코드·ADR·테스트에 대조했다. 원래 표현과 세부 관찰은 해당 데이터 repo의 Git 이력 및 Task 기록에서 확인할 수 있다. 본문은 다음 선택에 필요한 사실·미완료 범위를 보존하며, 반복된 대화·옛 우선순위·취소선 완료 목록은 옮기지 않았다.

| 이전 backlog 묶음 | 통합 위치·처리 |
|---|---|
| T-0006 종료의 6개 후속, 추가 관찰 | R02·R04~R06·R08~R11 |
| 1. 데이터 repo 정리 | 완료 이력. ignore·README·자기 프로젝트 등록은 T-0002/5/6에서 처리. 남은 검사 범위는 R11 |
| 2. 스키마·역할 프롬프트 | 완료된 F3/F6/F9/F11/F12/F13·생성 타입·meta 검사·packet_gaps 이관·2단계 Intake는 현재 표/ADR-0012~0017. 나머지는 R03·R05·R06·R09·R10 |
| 2. 문서·Store 결과 확인의 옛 지적 | 현재 commit_id 계약/실제 FileStore 테스트로 대체된 요구는 완료로 정리. 남은 캐시 제안·문서 정합은 R10·R11 |
| 3. Store와 기록 command | T-0005/6 완료. 교차 Task 조회·lock 안 읽기는 R07, OS/DB 실증은 R11·4단계 |
| 4. MVP·설정·사람 리뷰·역할 호출 정책 | R01~R08·R13. 사용자 방향과 조율 세션의 제안을 구별 |
| 후속 후보·검토 형식·GitHub·Planner 범위·Ledger | R04·R07·R10·R12. Planner의 유형 규칙은 2단계 Skill, done 재검사는 R06 |
| T-0006 뒤 Workspace→Runner 권고 | PR #1~#4와 HITL 후속 구현을 현재 표에 반영. 다음 후보는 R03 이후의 잔여 범위 |
| 미확인 목록 | 해결된 Worker 복구/Codex 어댑터는 완료, 나머지는 R02·R06·R10·R11·R13·4단계 |

이후 새 후보는 이 문서의 해당 R 항목에 출처와 함께 추가한다. 운영 중 발견한 사실은 먼저 해당 Task 기록에 남기고, Task 밖에서 추적할 조치만 여기로 올린다. 완료 항목의 상세는 ADR·회고·PR로 옮겨 연결하고 구현 현황을 갱신한다. `devflow-data/backlog.md`에는 이 문서 안내만 유지하며 두 목록을 다시 따로 운영하지 않는다.
