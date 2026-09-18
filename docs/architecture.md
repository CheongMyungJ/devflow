# Architecture

> 이 문서는 **현재 구조만** 기술한다. 변경 이유와 포기한 대안은 `adr/` 에 있다.

## 1. 원칙

**상태는 시스템에, 판단은 AI 에, 결정권은 사람에게.**

- AI 세션은 언제든 버릴 수 있어야 한다(매번 버리라는 뜻은 아니다). 모든 중요한 결과는 외부(State Store)에 저장되고, 새 세션은 Context 패킷만으로 작업을 이어갈 수 있어야 한다.
- 특정 AI 도구에 묶이지 않는다. Claude Code, Codex 등은 Runner 뒤의 교체 가능한 백엔드다.
- 모든 AI 역할은 `(Context 패킷) → (스키마로 검증되는 출력)` 형태의 함수처럼 다룬다.
- AI 는 제안하고, 시스템이 처리한다. 상태 전이는 시스템만 한다.

## 2. 구성 요소

```
사람 ──(대화/피드백/승인)──┐
                           ▼
        CLI/UI ─▶ commands / queries
                           │
┌──────────────── Orchestrator (결정론적 상태 머신, AI 미사용) ─────┐
│  advance(task_id): 이벤트 확인 → 상태 전이 → Context 조립         │
│                    → Runner 제출 → 결과 검증·저장                 │
└──────┬──────────────┬───────────────┬──────────────┬────────────┘
       ▼              ▼               ▼              ▼
    Intake         Worker      Quality Reviewer   Planner     (Role Runner 를 통해 실행)
       └──────────────┴───────┬───────┴──────────────┘
                              ▼
       State Store (append-only 이벤트 + 엔티티)      Workspace (대상 repo 의 task branch)
```

| 구성 요소 | 책임 | MVP 구현 | 확장 시 |
|---|---|---|---|
| commands / queries | 사람·외부가 시스템에 접근하는 유일한 경로 | in-process 함수 | HTTP API |
| State Store | Task/Step/Artifact/Feedback/GateResult/Decision/Event 저장 | 파일 (`devflow-data` repo) | DB + object storage |
| Orchestrator | 멱등 `advance(task_id)` | 사람이 `task run` 으로 호출 | 이벤트가 호출 |
| Role Runner | `submit / result / stream / sendMessage / cancel` + 백엔드 어댑터 | 로컬 subprocess (`claude-code`, `codex`, 테스트용 `fake`) | job queue + 컨테이너 |
| Workspace | Task 별 branch/worktree | 로컬 git | 서버 clone, remote 경유 |

## 3. 엔티티

```
Task 1 ─── N Step 1 ─── N Attempt ─── Artifact(version)
                │                         ▲
                │                     Feedback (특정 version 에 부착)
                ├── GateResult (특정 Artifact version 에 대한 판정)
                └── Decision   (Planner 출력: 다음 행동 + 근거)
```

필드 정의는 `schemas/` 가 기준이다.

- **Task** — 목표, 배경, 제약, 성공 기준(AC), 유형, 대상 repo
- **Step** — goal / scope / inputs / outputs / done_when / verify / approval
- **Artifact** — 문서는 `artifact://T/step/name@vN`, 코드는 `repo+branch+SHA`. 승인된 버전이 공식 기록
- **Feedback** — 수정 요청 / 질문 / 승인 / 요구사항 추가. 검토 시 또는 실행 중(live) 발생
- **GateResult** — pass/fail, 항목별 결과, 근거
- **Decision** — `next_step | rework | ask_human | done | abort` + 근거
- **Task Ledger** — 승인된 Step, 산출물 요약, 주요 결정의 누적 요약. Planner 는 전체 이력이 아닌 Ledger 를 입력으로 받는다

## 4. Step 생애 주기

```
proposed ─(사람 확인*)─▶ defined ─▶ running ─▶ checking ─▶ in_review ⇄ revising
                                                  │             │
                                                  │             ▼
                                                  │          approved ─▶ gate 확정 ─▶ Planner Decision
                                                  └─(자동 검증 실패 시 바로 revising)
```

- `checking`: Step 의 `verify` 에 **선언된 것만** 실행한다. 순서는 deterministic → semantic(AI 리뷰). 선언되지 않은 단계는 건너뛴다.
- 검증은 사람 검토 **전에** 수행하고, 결과를 검토 화면에 함께 제시한다. 공식 Gate 판정은 승인된 버전에 대해 확정하며, 버전이 같으면 캐시된 결과를 쓴다.
- `approval: optional` 인 Step 은 Gate 통과 시 `in_review` 를 건너뛴다. 단, `verify.deterministic` 이 비어 있으면 시스템이 `required` 로 강제한다.
- (*) Planner 의 Step 제안 확인은 MVP 기본값. 수정률이 낮아지면 `--auto-plan` 으로 생략한다.

## 5. 책임 경계

| 영역 | 담당 |
|---|---|
| 상태 전이, 저장, 권한, 재시도·예산 한도 | 시스템 |
| build/test/static analysis 실행 | 시스템 (결과를 Reviewer 에 입력으로 제공) |
| Context 패킷 조립 | 시스템 (Step 의 `inputs` 선언대로) |
| 작업 수행 | Worker — 자기 산출물을 승인하거나 다음 Step 을 정하지 않는다 |
| 의미적 검증 | Reviewer — 판정만 한다. 고치지 않는다 |
| 다음 행동 결정 | Planner — 다섯 가지 선택지 안에서만. 실행하지 않는다 |
| 승인, 요구사항 변경, 질문 응답 | 사람 |

안전장치: Step 당 재작업 횟수 상한, Task 당 Step 수·비용 상한. 초과 시 자동으로 `ask_human`.
`done` 결정은 AC 별 충족 근거가 필수이고 사람이 최종 확정한다.

## 6. Step 과 Skill

- Step 스키마는 하나다. **Freeform** 은 Planner 가 모든 필드를 작성하고, **Skill** 은 파라미터가 있는 Step 템플릿 + Worker 지침 + 기본 검증이다.
- Planner 가 `skill: X` 와 파라미터를 지정하면 시스템이 완전한 Step 정의로 펼친다. 이후 실행 경로는 Freeform 과 동일하다. Worker/Reviewer/Orchestrator 는 Skill 개념을 모른다.
- Skill 은 설계하지 않고 **추출**한다. 회고에서 반복 패턴이 확인되면 승격하고, 버전을 붙인다.

### 검증 구성 가이드

| Step 성격 | deterministic | semantic | 사람 승인 |
|---|---|---|---|
| 코드 구현/수정 | build, test, lint | 요구사항 충족, 범위 준수 | 선택 또는 필수 |
| 버그 재현 | 재현 테스트가 실패하는지 | 재현 조건 설명의 타당성 | 선택 |
| 계획/설계 | 없음 (또는 형식·경로 검사) | 완전성, 일관성, 실현 가능성 | 필수 |
| 원인 분석/연구 | 없거나 실험 재실행 | 근거와 결론의 논리적 연결 | 필수 |

결정론적 검증이 약할수록 사람 승인의 비중을 높인다.

## 7. 사람과의 상호작용

| 접점 | 방식 |
|---|---|
| Task 발행 | `task new` — Intake 와 실시간 대화. 발행 전 확인이 첫 승인 지점 |
| 진행 | `task run` — 사람 입력이 필요한 지점까지 `advance` |
| 검토 | `task review` — 산출물 + Gate 결과 확인 후 승인 / 수정 요청 / 질문 / 요구사항 추가 / 직접 수정 |
| AI 의 질문 | `ask_human` 시 멈춤 → `task answer` |
| 관찰 | `task run --watch`, `task attach`, `task log` — 제약 없음 |
| 실행 중 개입 | `task attach` 에서 메시지 전송 → `send_message` 명령으로 **이벤트 기록 후** 세션에 전달 |

- 수정 요청은 Step 산출물에, 요구사항 추가는 Task 에 붙는다.
- 사람의 직접 수정은 `submit_human_revision` 명령을 거쳐 새 버전으로 기록된다.
- 세션 안에서의 동의는 방향에 대한 동의일 뿐이다. 산출물 승인은 Gate 를 거친 특정 버전에 대해 `task review` 에서만 한다.
- Worker 는 Step 종료 시 "실행 중 받은 지시 요약" 을 출력한다. 사람은 검토 시 그중 Task 요구사항으로 올릴 것을 확인한다.
- Reviewer 세션에는 개입하지 않는다(검증 독립성). 판정에 이견이 있으면 결과에 피드백을 남긴다.

## 8. Runner 와 백엔드

구현: TypeScript + Node.js LTS. 인터페이스는 `src/runner/types.ts`.

- 어댑터는 각 도구의 headless CLI 를 subprocess 로 실행하고, 능력(`supportsLiveMessage`, `supportsResume`)을 선언한다. CLI 옵션 지식은 어댑터 밖으로 새지 않는다.
- 백엔드·모델은 역할별로 설정한다(Worker 와 Reviewer 를 다른 모델로 돌릴 수 있다). 실행마다 Run 기록(`schemas/run.schema.json`)에 backend, model, 버전, 세션 경로를 남긴다.
- **출력은 파일로 받는다.** 역할 프롬프트가 출력 디렉터리에 `<name>.json` 을 쓰도록 지시하고, 시스템이 스키마로 검증한다. 실패 시 오류를 붙여 재시도한다.
- **권한은 `access: read | write`.** 읽기 전용 실행 뒤 worktree 가 변경되었으면 실행을 무효 처리한다.
- **세션 선택**: 같은 Step 안에서 같은 역할이 이어가는 경우(질문, 수정 요청, 개입 후 재개)는 resume 우선. 다음 Step, Reviewer, Planner 는 새 세션. resume 실패 시 Context 패킷으로 새 세션을 띄운다.
- 실행 중 메시지를 지원하지 않는 백엔드는 "중단 → 메시지 포함해 resume" 으로 대체한다. 메시지는 어느 경우든 먼저 이벤트로 기록된다.
- Worker 는 산출물과 함께 **작업 노트**(주요 판단과 이유, 버린 방법, 미확인 사항)를 남긴다. resume 없이 이어가는 세션과 사람 검토, Planner 판단의 입력이 된다.
- transcript 는 백엔드 원본과 정규화본(text / tool_call / tool_result / end)을 함께 저장한다.
- repo 지침의 기준 문서는 `AGENTS.md`. `CLAUDE.md` 는 그것을 참조만 한다.

## 9. 여러 프로젝트와 동시 진행

- 상태는 Task 단위로 분리되어 있고 `advance(task_id)` 는 Task 별로 멱등이다. 여러 Task 를 동시에 진행할 수 있다.
- **Task 하나 = repo 하나 = worktree 하나.** Worker 와 Gate 는 그 Task 의 worktree 안에서만 실행한다. worktree 경로는 Workspace 관리자가 실행 시점에 풀어 주며 기록하지 않는다. 여러 repo 에 걸친 작업은 Task 를 나눠 발행한다.
- 프로젝트 이름 → remote URL·기본 branch 는 `devflow-data/projects.yaml` 에, 로컬 clone 위치는 머신별 설정에 둔다.
- 대상 repo 의 `.devflow.yaml`(`schemas/project-config.schema.json`)이 검증 명령을 정의한다. `exclusive: true` 인 프로젝트는 Gate 를 직렬로 실행한다.
- Store 파일 구현체는 Task ID 발급과 `devflow-data` commit 을 lock 으로 직렬화한다.
- 같은 repo 의 동시 수정은 막지 않는다. `advance` 가 base branch 이동을 감지해 Planner 에 알리고, Planner 가 "base 갱신 후 재검증" Step 을 만든다.
- `task status` 는 Task 전체에 걸쳐 사람 입력을 기다리는 항목을 보여 준다. 동시 실행 수 상한은 전역 설정이다.

## 10. 저장 위치

| 종류 | 위치 |
|---|---|
| 설계 문서, 스키마, 역할 프롬프트, Skill, 코드 | 이 repo (`devflow`) — 서버화 이후에도 git 에 유지 |
| Task 실행 데이터 | `devflow-data` repo — Step 전이마다 자동 commit. 서버화 시 DB 로 이전 |
| 코드 산출물 | 대상 repo 의 task branch. 대상 repo 에는 `.devflow.yaml` 만 추가 |

Task 이벤트에는 실행 당시 `devflow` repo 의 commit SHA 를 기록한다(어떤 버전의 프롬프트/스키마로 실행되었는지 추적).
