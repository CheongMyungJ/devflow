# 0단계 수동 운영 절차

도구(Orchestrator, CLI)가 아직 없는 동안 AI 대화 세션이 Orchestrator 역할을 손으로 한다. **대화 세션이 하는 것은 Intake(사람과의 대화)와 Orchestrator(기록, 검증, 역할 세션의 실행, 사람에게 보고)뿐이다. Planner, Worker, Reviewer 는 모두 Context 패킷만 받은 별도 세션으로 실행한다**(T-0002 부터. 아래 "역할 세션을 실행하는 법"). 이 문서는 **어떤 세션이든 이것만 읽고 이어갈 수 있도록** 그 절차를 적는다. 구조와 용어는 `architecture.md`, 규칙은 `../AGENTS.md`.

## 위치

| 무엇 | 어디 |
|---|---|
| 시스템 repo (이 repo) | `C:\git\devflow` — main 에는 설계·스키마·역할 프롬프트·운영 스크립트 |
| Task 데이터 repo | `C:\git\devflow-data` — `T-NNNN/` 마다 task.yaml, ledger.md, events.jsonl, decisions/, steps/. 구조는 그 repo 의 README |
| Task 작업 공간 | `C:\git\devflow-worktrees\T-NNNN` — branch `task/T-NNNN-*` 의 worktree. `npm ci` 가 되어 있어야 한다 |

## 상태를 복원하는 법 (세션을 새로 시작했을 때)

1. `devflow-data/T-NNNN/ledger.md` — 승인된 Step 의 요약, 주요 결정, 진행 중인 것, 후속 Task 후보.
2. `devflow-data/T-NNNN/events.jsonl` 의 마지막 10~20줄 — 지금 어느 Step 이 어떤 상태인지. `step.status_changed` 의 마지막 `to` 가 현재 상태다.
3. 진행 중인 Step 의 `steps/step-NNN/` — `step.yaml`(정의), `gates/` 의 마지막 Gate, `runs/*.work-notes.md`(Worker 가 남긴 판단과 "확인하지 못한 것"), `feedback/`.
4. `git -C C:\git\devflow-data status` 와 `git -C <worktree> status` — commit 되지 않은 것이 있으면 이전 세션이 도중에 끊긴 것이다. 내용을 보고 이어 갈지 버릴지 정한다.
5. `run.submitted` 는 있는데 `run.completed` 가 없는 Run 은 이전 세션과 함께 사라진 실행이다(서브에이전트는 세션을 넘지 못한다). 그 Run 을 `run.failed` 로 기록하고 다시 실행한다.

## 한 Step 의 절차

```
Planner 가 Step 제안(decisions/D-NNN.yaml, steps/step-NNN/step.yaml: proposed)
  → 사람이 확인                                   step.defined
  → Worker 실행                                    run.submitted / run.completed, artifact.version_added
  → deterministic 검증 (.devflow.yaml 의 @typecheck, @test)
  → Worker 의 작업 노트를 쓴다 (Reviewer 보다 먼저)
  → Reviewer 실행 — 반드시 새 독립 세션            gates/G-NNN.yaml, gate.completed
      fail → 사람을 거치지 않고 재작업 (revising → checking)
      pass → in_review, 사람에게 검토 요청
  → 사람: 승인 / 수정 요청 / 질문                   feedback/F-NNN.yaml
  → 승인되면 Artifact 의 approved: true, step closed, ledger.md 에 요약 추가
  → Planner 가 다음 행동 결정 (next_step / ask_human / done …)
```

- **누가 수행했는지 사실대로 적는다.** Ledger 의 운영 메모에 수행 주체를 적는다. 대화 세션이 역할을 겸한 일이 있으면(T-0001 이 그랬다) 그렇게 쓴다.
- **Reviewer 에게 주는 것**: `roles/reviewer.md`, Task·Step 정의, 검토 대상 commit 과 diff 명령, 이전 Gate, Worker 의 작업 노트(특히 "확인하지 못한 것" — 지금까지 실제 결함은 모두 여기서 나왔다), deterministic 결과. "값싸게 확인할 수 있으면 실행해서 확인하라" 고 지시한다. 출력은 verdict / checks / done_when / comments(severity: defect·risk·note, class: A 승인 전 수정·B 후속·C 의견)의 JSON.
- Reviewer 에게 임시 파일을 쓰게 할 때는 **자신이 만든 디렉터리 하나만** 쓰고 그것만 지우게 한다.
- **사람에게 검토를 요청할 때**는 Gate 의 용어를 그대로 옮기지 않는다. "무엇이 바뀌었나 / 무엇을 정해야 하나 / 내 권고" 를 쉬운 말로 먼저 쓰고, 상세는 그 뒤에 둔다.
- 사람의 Feedback 이 Step 의 done_when 이나 Task 의 AC 의 문구를 바꾸면(스키마에 반영할 자리가 아직 없다) Feedback 에 "무엇에 우선하는지" 를 적고, 이후의 Worker·Reviewer·Planner 패킷에 그 Feedback 을 넣는다.

## 역할 세션을 실행하는 법

서브에이전트(또는 `claude -p`)를 **새로** 띄운다. 같은 역할의 두 번째 실행도 앞 실행을 이어가지 않는다 — 작업 노트와 기록만으로 이어받을 수 있는지가 시험 대상이다. 프롬프트에는 대화의 맥락을 풀어 쓰지 않고 아래 틀만 채운다. **결과가 나쁘면 패킷을 몰래 보강하지 않는다. 그것이 Step 정의·Ledger·스키마의 부족을 드러내는 정보이므로 Ledger 와 회고에 적는다.**

```
당신은 devflow 의 <역할> 세션이다 (Run R-NNN, Task T-NNNN[, Step step-NNN][, 재작업]). 이전 세션의 기억은 없다.
이 프롬프트에 없는 맥락은 주어지지 않는다. 패킷의 파일과 거기서 참조되는 파일에서 직접 확인하라.

## Context 패킷
- 역할 지침: roles/<역할>.md 의 경로
- Task 정의, (Planner) Ledger, (Worker·Reviewer) Step 정의의 경로
- Step 의 inputs: 참조 → 로컬 위치 (task.brief → task.yaml, code://<repo>@<sha> → worktree 또는 읽기 전용 clone. 기준은 SHA 다)
- (Planner) 직전 Step 의 공식 Gate, Feedback, 이전 Decision, Skill 카탈로그(지금은 비어 있다), 남은 한도
- (재작업 Worker) 이전 버전의 commit 과 meta, 이전 실행의 작업 노트, Feedback, Gate
- (Reviewer) 검증 대상 Artifact 의 commit 과 diff 명령, 작업 노트, 시스템의 deterministic 결과, 이전 Gate, 재작업이면 Feedback
- verify 에 서술로 적힌 검사가 있으면 그 실제 명령

## 출력
- 출력 파일의 경로 하나(아래 표)와 형식. 시각은 추정하지 말고 얻어서 적는다. 로컬 경로를 쓰지 않는다.
- `packet_gaps`: 패킷에서 부족했거나 모호했던 점을 출력 파일 안에 적는다(없으면 없다고).
- (Reviewer) "값싸게 확인할 수 있으면 추론하지 말고 실행해서 확인하라", "작업 노트의 '확인하지 못한 것' 을 먼저 공격하라",
  comments 는 `[severity / class]` 로 시작, A 등급이 하나라도 있으면 fail.
- (Worker) commit 은 task branch 에, push 하지 않는다. 작업 노트에 "확인하지 못한 것" 절은 필수.

## 금지
- 출력 파일(과 Worker 의 Workspace) 외에는 아무것도 만들거나 고치지 않는다. 스스로 승인하지 않는다. 다음 Step 을 정하지 않는다.
```

| 역할 | 출력 파일 | 반영 |
|---|---|---|
| Planner | `T-NNNN/runs/R-NNN.output.yaml` (Decision) | `decisions/D-NNN.yaml` 로 복사 → `npm run propose-step -- <task-dir> D-NNN step-NNN` |
| Worker | task branch 의 commit + `steps/step-NNN/runs/R-NNN.work-notes.md` | Orchestrator 가 deterministic 검사를 직접 다시 실행하고 `gates/G-NNN.deterministic.md` 에 적는다. `artifacts/<name>/vN.meta.yaml` 작성 |
| Reviewer | `steps/step-NNN/runs/R-NNN.output.json` | `npm run record-gate -- <task-dir> step-NNN G-NNN R-NNN <artifact-ref,…>` |

Run 기록은 세션을 띄우기 **전에** `status: submitted` 로 쓰고(`run.submitted`), 끝나면 `completed` 로 바꾼다. Step 에 속하지 않는 Run(Planner)은 `T-NNNN/runs/` 에 둔다. `run.submitted` 의 note 에 "대화 세션이 끝나면 결과를 잃는다" 를 적어 둔다. 반영은 항상 `validate-data` 를 통과한 뒤에 한다 — 역할 세션의 출력은 제안이다(AGENTS.md 6·13번).

## 기록하는 법

- 엔티티(yaml)는 `schemas/` 를 따른다. 이벤트는 직접 쓰지 말고 스크립트로 append 한다. seq 와 task_id 는 스크립트가 부여한다. 새 Task 의 `events.jsonl` 도 이 스크립트가 만든다.
- **시각은 추정하지 말고 얻어서 적는다** (`(Get-Date).ToUniversalTime()`). T-0001 의 seq 104 까지는 추정값이라 실제보다 앞서 있다.
- **이미 쓴 이벤트 줄은 형식 오류가 있어도 고치지 않는다. 정정 이벤트를 덧붙인다. 예외 없음**(사람의 결정, 2026-09-19).
- Decision 의 사람 수정 여부는 `step.defined` 이벤트의 `data.human_edit` 에 고친 것이 없어도 `false` 로 남긴다.
  ```
  cd C:\git\devflow
  npm run append-events -- C:\git\devflow-data\T-0001 <events.json>
  npm run validate-data -- C:\git\devflow-data
  ```
- **검증이 통과한 뒤에만 commit 한다.** PowerShell 에서는 `$ErrorActionPreference='Stop'` 을 걸고, 단계마다 `$LASTEXITCODE` 를 확인한다. 앞 단계가 실패했는데 commit·push 가 진행된 사고가 두 번 있었다.
- 운영에 쓰는 스크립트와 자료는 세션의 임시 폴더가 아니라 이 repo 의 `scripts/` 에 둔다. 임시 폴더는 다른 세션에서 보이지 않고 사라질 수 있다. 지금 있는 것: `append-events`, `validate-data`, `propose-step`, `record-gate`.
- **Task 가 진행되는 동안에는 이 repo 의 main 에 운영 스크립트를 commit 하지 않는다**(역할 세션이 보는 clone 의 HEAD 가 움직여 검증의 기준 SHA 가 흔들린다 — T-0002). 대상 repo 가 이 repo 인 Task 라면 더욱 그렇다. 꼭 필요하면 Ledger 에 적는다.
- commit 작성자는 두 repo 의 로컬 git 설정에 있다. 메시지 끝에 `Co-Authored-By` 줄을 붙인다. `devflow-data` 는 private repo 다.
- 상태 기록에 로컬 경로를 쓰지 않는다. 문서는 `artifact://…@vN`, 코드는 repo + branch + SHA.

## Task 를 끝낼 때

Planner 의 `done` 결정(AC 별 근거) → 사람의 최종 확인 → task branch 를 main 에 merge(또는 PR) → worktree 정리 → `docs/retro/T-NNNN.md` 작성(템플릿은 `retro/README.md`) → `roadmap.md` 의 체크리스트 갱신 → **Ledger 의 "후속 Task 후보" 와 회고의 개선 조치를 `devflow-data/backlog.md` 로 옮긴다.** Ledger 는 Task 와 함께 닫히므로 거기에만 적힌 것은 잊힌다.

## 다음에 무엇을 할지

`devflow-data/backlog.md` 에 Task 후보가 권고 순서와 이유와 함께 있다. 큰 방향과 단계 전환 기준은 `roadmap.md`. 새 Task 는 사람이 backlog 에서 골라 Intake 를 거쳐 발행한다.
