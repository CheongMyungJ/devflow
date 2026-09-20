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

문서 통합 시 확인한 로컬 checkout은 `codex/real-worker-runners`의 `b2cdab8`이다. PR 병합 확인과 로컬 main 갱신은 별개다.

- 마지막 코드 검증: Windows, Node.js 22.15.1, `npm run typecheck` 통과, `npm test` **46개 파일·678개 통과**. 문서 통합을 위해 모델 호출을 다시 실행하지 않았다.
- **대역 계약 테스트**: fake 회귀와 세 CLI 어댑터의 인자·입력·cwd·model, 정상/지연/비정상 종료, JSON/스키마 위반, 실행 파일 부재, 호출자 강제 종료 후 회수, 중복 제출/수집, unknown, Task 간 같은 Run ID, 기존 Git 변경 보존. 실제 Git으로 종료 SHA 확정도 검사했다.
- **실제 모델 실행**: Claude Code **2.1.278**(sonnet 요청), Codex **0.154.0**(CLI 기본 모델)을 각 1세션 실행했다. 임시 대상 repo·Task Workspace·테스트 Store에서 작은 파일 생성, 실제 cwd, 출력 파일 검증, 실행 중 호출자 SIGKILL 후 회수, Run/Artifact 기록과 반복 수집을 확인했다. 실제 세션의 Artifact는 보고 문서이며, 코드 commit SHA 확정은 위의 Git+대역 테스트로 검증했다. 이 2회는 678개 테스트 수에 포함하지 않는다.
- **실제 OpenCode 연동은 미검증**이다. 어댑터와 대역 계약 테스트는 완료했으나 설치된 CLI/실제 모델 호출은 검증하지 않았다. 다른 OS·모든 모델/CLI 버전·임의 명령의 권한 허용까지 확인한 것은 아니다.
- 재현 방법·CLI 호환성·실행 옵션의 근거는 [Runner 계약](design/runner.md), 사용 예는 [수동 운영 절차](stage0-manual-operation.md)를 따른다.

### 완료된 기반과 남은 경계

| 영역 | 상태 | 구현된 것 | 남은 경계 |
|---|---|---|---|
| 스키마·타입·역할 계약 | 부분 완료 | 스키마 로더, 생성 타입, Task 의도/2단계 Intake, 역할 출력·packet_gaps·수행 주체·참조 문법 | 잔여 의미 검사와 계약 정합은 R09·R10 |
| State Store | 완료 — 파일 기반 최소 계약 | 7종 엔티티, blob, ID/버전 발급, 불변 기록, append-only 이벤트, commit 식별자와 장애 복구 | 교차 Task 조회·운영/OS 확장·DB 중립성 실증은 R07·R11·4단계 |
| commands/queries·운영 입구 | 부분 완료 | Task 발행/done, Step 제안/확정, Run 제출/완료/실패, Gate 기록, Feedback/승인/재작업, Workspace·Worker 입구 | Gate **실행**과 전체 조율, 취소·Intake 완료, 제품 CLI는 R02·R05~R07 |
| Workspace | 부분 완료 | 프로젝트 등록부 스키마/조회 시 검사, 머신별 clone/worktree 설정, Task worktree 준비·조회, 기준 SHA 고정, 단계 경계 복구 | 안전한 정리·base 이동·읽기 참조 checkout·의존성 준비는 R08 |
| Worker Runner | 완료 — 신규 Worker/write | fake·Claude Code·Codex·OpenCode 어댑터와 공통 로컬 실행 관리, 출력 파일 검증, 멱등 수집, `workspace:code` 종료 SHA 검증 | 다른 역할·read 격리·취소/timeout·resume·메시지·transcript는 R02 |
| 역할별 실행 설정 | 부분 완료 | Worker 입력/CLI에서 backend 선택, 입력의 model 전달·일치 검사. backend 생략은 기존 fake와 호환 | 네 역할의 설정 파일, 전역/프로젝트 계층, 추론 수준은 R01 |
| Context·Ledger·검토 자료 | 미구현 — 자동화 | 수동 패킷·Ledger·독립 역할 운영 경험과 입력 참조 문법은 있음 | 자동 조립·Feedback 우선순위·후속 후보·사람용 렌더링은 R03·R04·R07 |
| Gate·Orchestrator | 미구현 — 실행 루프 | GateResult 기록과 상태 전이 command는 있음 | deterministic 실행+Reviewer, 멱등 `advance()`는 R05·R06 |

**지금 할 수 있는 일:** 사람이 Task/Step과 입력을 준비하고 Workspace를 마련한 뒤, backend를 명시해 Worker 신규 세션을 제출하고 나중에 결과를 수집한다. prompt/Context는 호출자가 제공한다. 시스템이 Intake부터 done까지 스스로 연결하지는 않는다.

**복구 경계:** 공유 `Run.status`는 수집 전까지 `submitted`, 실제 관찰 상태는 `execution.state`다. 종료 결과 없이 출력만 생긴 경우, 시작 표식만 남은 경우, supervisor 유실·로컬 기록 손상은 완료/실패로 추측하지 않고 `unknown`으로 둔다. 살아 있는 supervisor가 결과를 게시하면 같은 실행을 회수한다. 그렇지 않으면 사람이 기존 프로세스와 변경을 확인해야 한다. 시작 표식·잠금 삭제나 자동 대체 실행으로 덮지 않는다([ADR-0019](adr/0019-recoverable-worker-execution.md), [ADR-0020](adr/0020-local-cli-worker-adapters.md)).

### 단계 판단

수동 Task T-0001~T-0006은 끝났고 1단계의 Workspace·Runner 기반도 구현됐다. 그러나 **0→1단계 전환의 공식 판단은 미확정이며, 전체 MVP 루프는 미완료**다. T-0006은 스키마 변경을 범위에서 제외했으므로 변화가 없었다는 사실이 스키마 안정화의 증거는 아니다. [T-0006 회고](retro/T-0006.md)의 당시 다음 후보인 Workspace·Runner는 이제 완료 범위를 위 표로 판단한다. 과거 회고는 현재 계획에 맞춰 다시 쓰지 않는다.

## 다음 작업 순서

아래 순서는 권고이며 아직 새 Task를 발행한 것이 아니다. **우선 추천은 R01: 네 역할의 실행 설정**이다. 설정 지원과 네 역할의 실제 실행 지원은 구별한다.

| 순서 | 후보 | 이번에 해결할 중심 | 선행 조건·분리할 범위 |
|---|---|---|---|
| 1 | [R01 역할별 실행 설정](#r01) | Intake·Planner·Worker·Reviewer의 backend/model/추론 수준, 전역/프로젝트 설정과 실효값 확정 | 기존 Worker부터 연결하되 다른 역할 설정도 수용·검사. 역할 실행 자체는 R02 |
| 2 | [R02 역할 실행·격리](#r02), [R03 Context·재작업](#r03) | 읽기 역할을 실행할 계약과 충분한 새 세션 입력 | read·환경 격리와 입력 계약을 먼저 좁혀 구현. resume/attach까지 한 번에 묶지 않음 |
| 3 | [R04 Ledger·후속 후보](#r04), [R07 검토 자료](#r07) | 기록 누락 없이 다음 판단과 사람 검토에 필요한 재료 | Ledger 작성 방식·출력 필드 판단은 advance 전에. GitHub 발행은 뒤로 |
| 4 | [R05 Gate](#r05) → [R06 advance](#r06) → [R07 제품 CLI](#r07) | 작은 Task 한 바퀴를 멱등하게 연결 | 처음부터 모든 대화형 명령·정책을 구현하지 않고 수직으로 작은 흐름 검증 |
| 병행 후보 | [R08 Workspace](#r08)·[R09 계약 정합](#r09)·[R10 지침](#r10)·[R11 운영 검증](#r11) | 선택한 기능을 실제로 막는 항목 또는 독립적인 작은 결함 | 잔여 스키마 전부를 먼저 한 묶음으로 고치지는 않음 |

## 1단계 — MVP의 남은 작업

범위는 사용자 1명, Task당 대상 repo/worktree 1개, 여러 프로젝트·Task, Task 안의 순차 Step, 작은 버그 수정·소규모 기능이다. Skill 없이도 한 바퀴를 수행해야 한다. 각 R 항목은 작업 묶음이므로 한 Task보다 클 수 있다.

<a id="r01"></a>
### R01. 네 역할의 backend·model·추론 수준 설정

**상태: 부분 완료 / 우선 추천.** 출처: T-0004 설정 요청, ADR-0010, 2026-09-20 사용자 재확인.

- **사용자 방향:** Worker, Reviewer, Planner, Intake 모두 설정할 수 있어야 한다. backend·model·추론 수준을 지정하며, 전역 기본값과 프로젝트별 설정으로 확장할 수 있어야 한다. 작업 유형별 지정도 기존 요청에 포함된다.
- 현재는 Worker의 명시적 backend/model만 있다. 전역/프로젝트 역할 설정과 reasoning 입력·기록은 없다. 머신별 Workspace 경로 설정은 역할 실행 설정과 목적이 다르다.
- **첫 구현 범위 권고:** 네 역할의 설정 스키마·조회·실효값 해석, Worker 연결, 지원하지 않는 backend/model/reasoning 조합의 명시적 거부, 기존 fake/명시 입력 호환. 실행 불가한 역할은 설정 가능하더라도 실행 가능하다고 표시하지 않는다.
- **미결정:** 설정 파일 위치·키·기본값·우선순위. 명시 실행 옵션 > 프로젝트 역할 설정 > 전역 역할 설정 > 제품 기본값은 후보이며, 기존 제안인 Step > Skill/작업 유형 > 프로젝트 역할 > 시스템 역할과 함께 일관된 규칙을 정한다. freeform Step의 작업 유형 표현, Planner가 유형만 고르고 모델은 정책이 고르는 방식도 미결정이다.
- 백엔드별 추론 수준은 지원 범위와 의미가 다를 수 있다. 로컬 CLI 도움말·공식 자료를 확인해 어댑터가 변환/검사한다. 미지원 값을 조용히 무시하지 않는다. 인증·사용자 전역 CLI 설정을 자동 변경하지 않는다.
- **완료 기준:** 네 역할의 설정 해석과 우선순위 계약 테스트, 잘못된 값/미지원 기능 오류, 기존 Worker 호환, 사용 예. 실제 실행에 적용할 실효값을 제출 때 확정하고 digest·Run의 재현 가능한 기록에 반영한다. 이후 설정 파일 변경이 기존 실행을 바꾸지 않아야 한다. 추론 수준의 새 엔티티 필드는 스키마에서 정의한다.
- Reviewer 사용 여부·깊이, 재작업 시 상위 모델로 변경하는 규칙은 [R06](#r06)의 정책 질문이다. 모델별 품질·비용 우열은 [R13](#r13)의 비교 없이 단정하지 않는다.

<a id="r02"></a>
### R02. 다른 역할 실행과 Runner의 나머지 기능

**상태: 부분 완료.** 신규 Worker/write의 복구 계약은 기반으로 유지한다([Runner](design/runner.md), ADR-0010·0019·0020).

- Planner·Reviewer의 신규 read 실행과 역할별 출력 수용을 구현한다. **사용자 방향:** Planner도 해당 Task worktree에서 실행한다. Reviewer는 독립된 새 세션으로 판정한다. Task/Workspace가 생기기 전 Intake의 cwd·대화 수명·Run 완료 계약은 별도로 정한다.
- read 실행에서 tracked/staged/unstaged/untracked 변경과 ignored 생성물(`node_modules`, 생성 타입 등)의 허용 범위를 정하고 검사한다. 리뷰를 위한 복사 데이터·임시 실험과 원래 Workspace 변경을 구별한다. 변경을 발견해도 자동 reset/삭제하지 않는다.
- 프로젝트 지침은 필요한 맥락으로 허용하되, 무관한 사용자 전역 설정·메모리·계정 커넥터 유입을 어떤 옵션으로 제한하는지 백엔드마다 검증한다. cwd 변경만으로 격리됐다고 보지 않는다. 현재 어댑터는 기존 CLI/프로젝트 설정의 영향을 받는다.
- 공통 관리에 timeout·취소·진행 관찰을 추가할 때 프로세스 종료 근거와 상태/이벤트를 정한다. 현재 `supportsResume/LiveMessage/Stream/Cancel`은 모두 false다. 지속 outputDir·raw 로그·호출자 종료 후 회수는 이미 있으므로 다시 만들지 않는다.
- backend session ID, 실제 프로세스 종료 시각과 수집 시각, CLI 대화 로그와 Run의 연결, 보관 기간·크기·비공개 내용 정책을 정한다. 하위 세션이 생기면 모델·토큰·출처도 관찰할 필요가 있으나 범용 멀티 에이전트 플랫폼으로 확대하지 않는다.
- 출력 자동 재시도, transcript 정규화, attach/log, 실행 중 메시지는 후속 단위로 분리한다. 사람 메시지는 이벤트를 먼저 기록한 뒤 전달한다(ADR-0006).
- **사용자 결정:** resume 정책은 resume/개입 기능을 만들 때 논의한다. 기존 수동 resume 1회의 시간·비용은 일반 정책의 근거가 아니다. 실패하면 Context로 새 세션을 시작할 수 있어야 하고, 불명확한 기존 실행을 대체하는 자동 재실행으로 오용하지 않는다.
- **완료 기준:** 역할별 계약·read 위반·지원 capability·실패/취소/복구 테스트와 기록 일관성. 대역/실제 CLI/실제 모델 검증을 나누어 보고한다. OpenCode 실제 연동은 현재 미검증 상태로 유지하며 별도 범위가 정해지기 전 자동 실행하지 않는다.

<a id="r03"></a>
### R03. Context·Feedback·재작업 입력 계약

**상태: 미구현 — 자동 조립.** 출처: T-0002 Feedback 우선순위, T-0004/5 packet_gaps, T-0006 재작업 운영, ADR-0001·0008·0010·0012.

- Task/Step, 입력 Artifact 버전, Gate, Feedback, Ledger와 원문 패킷을 재현 가능하게 제공한다. 수동 운영은 T-0005부터 패킷 원문 blob을 남기며, 현재 Worker Runner도 명시적 prompt를 로컬 요청에 보관한다. 자동 조립한 패킷의 공유 기록·출처 계약은 남았다. Feedback 원문과 현재 Task의 살아 있는 기록을 가리킬 참조가 필요하다. 과거 `code://devflow-data@<sha>`만으로 이후 기록을 대체하지 않는다.
- Feedback이 AC/done_when을 바꿨을 때 실효 정의·이력·우선순위를 정한다. “승인하되 다음 Step에서 반드시 수정”을 사람이 쓴 문장에만 두지 않고 전달·이행 여부를 확인할 계약을 정한다.
- 재작업은 앞 버전 commit이 있는 Workspace에서 시작하고 기존 commit을 고쳐 쓰지 않는 수동 운영을 제품 계약으로 구체화한다. 원래 정의·사람 Feedback·이전 Artifact/commit/meta/전체 노트/검증·실패 Gate 전체를 필수 입력으로 검토한다. 시작 HEAD 검사 책임, A/범위 내 B 지적 전달 형식, Reviewer의 새 버전 전체 검토를 명시한다.
- 다른 프로젝트의 `code://`는 등록부의 고정 SHA 읽기 참조로 제공한다. 로컬 checkout 경로는 구현 경계 안에서 해석한다. 준비는 R08과 연결한다.
- Step proposal을 사람이 말로 수정 요청해 Planner가 재제안하는 경로를 정한다. 현재 `define-step --edited`는 사람이 실효 정의를 만들어 주는 입구다. Feedback 종류·제안 취소와 재제안은 R06과 연결한다.
- **완료 기준:** 새 세션이 이전 대화 없이 필요한 증거를 찾고, 재작업 시작 버전·요구 변경·carry-over가 누락되지 않는 계약 테스트와 작은 실제 흐름. Context에 무엇이 들어갔는지 원문/출처를 확인할 수 있어야 한다.

<a id="r04"></a>
### R04. Ledger 자동 작성과 후속 후보의 지속적인 기록

**상태: 미결정·미구현.** 출처: T-0005/6 사용자 요구, ADR-0001. advance 구현의 선행 계약이다.

- **사용자 방향:** 사람 손 없이 필요한 기록이 빠짐없이 Ledger에 남고, Task에서 나온 후속 조치가 Task 밖의 후보로 이어져야 한다. 후보 우선순위·정리는 사람의 일이며 지금 범용 이슈 엔티티를 만들지는 않는다.
- **미결정:** 승인된 출력·Gate·Feedback·Decision에서 결정론적으로 조립 / 별도 AI 요약 역할 / Planner가 기록 재료를 출력. 역할이 Ledger를 직접 쓰는 방식으로 결정된 적은 없다.
- 다음 Step 전달사항, 상세 증거의 참조, 승인된 버전·검증·결정·변경된 요구·미확인 사항·후속 조치를 보존한다. 승인된 사실과 아직 열린 질문/미승인 제안을 구별하고 반영 시점을 정한다. Ledger는 원본 증거를 대체하지 않는다.
- 후보 추출 대상: Gate의 B 지적, 작업 노트의 미확인 사항, packet_gaps, 회고 개선 조치, Planner done에 딸린 후속. 추출 주체·시점·형식·목적지와 Task/Gate/Run 출처를 정한다. 프로젝트별 파일 또는 트래커로 내보낼 수 있는 경계를 검토한다.
- **완료 기준:** T-0001~T-0006 Ledger에서 다음 판단에 쓰인 재료를 대조하고, 중단/재수집 시 누락·중복 없이 Ledger와 후속 후보가 남는 최소 흐름을 검증한다.
- 후보에서 Intake 초안을 만들고 발행 Task에 연결하는 **들어오는 흐름**은 후속이다. 한 후보의 분할·부분 처리·여러 Task, 사람이 직접 시작한 Task와의 동일한 처리 규칙도 그때 정한다. 현재 이 로드맵 통합은 자동 후보 관리 기능의 구현이 아니다.

<a id="r05"></a>
### R05. Gate 실행과 판정 계약

**상태: 미구현 — 실행 / 부분 완료 — 결과 기록.** 출처: ADR-0003·0004·0017, T-0003 deterministic 작성 주체, T-0006 G-006/F-008/R-018.

- `.devflow.yaml`의 deterministic 명령과 semantic Reviewer 1회를 실행하고 기존 recordGate에 연결한다. 명령 직접 지정과 `@이름`, 다른 repo의 검증 스크립트와 고정 SHA를 로컬 경로 없이 표현할 규칙을 정한다.
- deterministic 결과는 누가 생성·합성하는지 명시한다. Reviewer가 주장한 실행을 시스템 실측과 혼동하지 않는다. 실행 로그와 검사 대상 Artifact 버전을 연결한다.
- Gate verdict=pass인데 개별 check=fail인 경우와 A/B/C 지적·사람의 수용 관계를 정한다. 검토 화면에서 개별 fail을 숨기지 않는다. 코드상의 기록 검증과 실제 검사 실행은 별개다.
- `exclusive` 프로젝트의 Gate 직렬화와 Task Workspace 실행을 보장한다. 실패 뒤 자동 재작업이 시스템 규칙인지 Planner 결정인지 R06과 함께 새 ADR로 정한다.
- **완료 기준:** 통과/실패/실행 오류/중단 결과와 Reviewer 출력을 구분해 기록하고, 같은 실행/수집을 반복해 Gate·Run·이벤트가 중복되지 않는 검증.

<a id="r06"></a>
### R06. 멱등 advance와 사람의 결정·취소 정책

**상태: 미구현.** 기존 commands와 상태 전이를 재사용한다. 선행: R02~R05의 최소 계약.

- `advance(task_id)`를 여러 번 불러도 같은 진행을 만들고, Store 기록과 외부 프로세스 시작을 원자적으로 가정하지 않는다. 재작업·Step 수·비용 상한을 정한다.
- `cancelStep`, Task 중단, Run 취소, Intake Run 완료 경로를 구체화한다. Event의 종류별 data 계약(F5)을 관련 전이와 함께 정의한다. 상태 전이는 시스템만 한다.
- 역할을 생략하거나 사람이/조율 세션이 직접 수정했으면 실제 수행 주체·이유·검사 범위를 기록한다. 수행하지 않은 Planner/Reviewer/Gate를 수행한 것처럼 쓰지 않는다.
- **사용자 요청, 설계 미결정:** 승인 정책의 Planner 판단 기본/항상 사람 확인/사람 확인 생략 모드, Reviewer 사용 여부·깊이, 작업 유형별 정책과 재작업 시 모델 변경. 현재의 verify 최소 하나, deterministic이 없으면 approval required, 특정 Artifact 버전 승인 규칙은 유지한다. `verify: none`이나 설정에 의한 일괄 우회는 채택된 계약이 아니며 변경하려면 ADR과 안전 조건을 먼저 정한다.
- **미결정 제안:** Intake에 검토를 집중, Planner가 새로 정한 것이 있을 때 Step 확인, Worker 시작 직후 가정 확인, 작은 Task의 빠른 경로·Skill로 뻔한 Step 생략. 기존 고정 흐름을 이미 대체했다고 보지 않는다. Reviewer 판정의 독립성도 유지한다.
- Task done의 사람 확인을 Task 수준 Feedback으로 남길지, 이벤트 actor/data로 충분한지 정한다(F4/F7의 남은 부분). 원래 success_criteria와 결과·한계를 대조하고 AC 번역만으로 완료를 판단하지 않는다.
- merge/push/문서/후속 이관 등 done 이후 절차와 실행 권한을 구분한다. main 검증 실패 시 재개/추가 승인/Task branch 관계를 정한다. 완료가 자동 merge·push 권한을 뜻하지 않는다.
- **완료 기준:** 작은 Task의 성공·Gate 실패 재작업·질문·요구 변경·사람 수정·취소·프로세스 중단 후 재호출을 테스트한다. Worker 단독 crash 테스트만으로 전체 Orchestrator 인계가 검증됐다고 하지 않는다.

<a id="r07"></a>
### R07. 제품 CLI와 사람이 읽을 검토 자료

**상태: 미구현 — 제품 CLI / 부분 완료 — 운영 스크립트.** 출처: T-0005 검토 요청, Store 3.9, 기존 MVP 계획.

- `task new / run / status / review / answer`를 commands/queries 위의 얇은 입구로 제공한다. attach/log는 R02의 지원 capability에 맞춰 후속으로 제공한다. 조립 지점만 구현체를 알며 architecture 테스트로 경계를 지킨다.
- Task 전체의 “내 입력 대기” 조회, 진행 중 Store commit의 읽기 대기/StoreBusyError 안내를 만든다. 교차 Task 조회와 lock 안 읽기가 필요하면 Store 인터페이스의 확장안을 실제 사용 사례로 검증한다.
- 검토에 필요한 내용은 무엇이 바뀌었는지, 사람이 정할 것과 선택지/권고/책임, 미확인·남는 한계, 상세 근거다. 원래 성공 기준과의 대조, 재작업 이유/시작 버전/전체 재검토, 생략한 검증도 보여 준다.
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
- Worker 실행 중 호출자 강제 종료/복구는 완료됐다. 전체 Orchestrator·여러 역할·실행 중 사람 개입·동시 인계는 아직 미검증이다. 수동 인계의 앞 세션이 다시 쓰는 문제까지 다룬다. 전원 장애·분산 실행의 보장을 추정하지 않는다.
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
| 1 — 얇은 MVP | 위 R01~R13 중 최소 전체 루프와 실제 업무 적용. 후속 기능은 개별 범위로 분리 | 실제 Task 10~20개 수행. 기반만 구현한 현재는 미충족 |
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
| T-0006 뒤 Workspace→Runner 권고 | PR #1~#3 완료 범위를 현재 표에 반영. 다음 권고는 R01부터 |
| 미확인 목록 | 해결된 Worker 복구/Codex 어댑터는 완료, 나머지는 R02·R06·R10·R11·R13·4단계 |

이후 새 후보는 이 문서의 해당 R 항목에 출처와 함께 추가한다. 운영 중 발견한 사실은 먼저 해당 Task 기록에 남기고, Task 밖에서 추적할 조치만 여기로 올린다. 완료 항목의 상세는 ADR·회고·PR로 옮겨 연결하고 구현 현황을 갱신한다. `devflow-data/backlog.md`에는 이 문서 안내만 유지하며 두 목록을 다시 따로 운영하지 않는다.
