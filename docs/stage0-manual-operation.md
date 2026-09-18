# 0단계 수동 운영 절차

도구(Orchestrator, CLI)가 아직 없는 동안 AI 대화 세션이 Orchestrator 역할을 손으로 한다. 이 문서는 **어떤 세션이든 이것만 읽고 이어갈 수 있도록** 그 절차를 적는다. 구조와 용어는 `architecture.md`, 규칙은 `../AGENTS.md`.

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

- **누가 수행했는지 사실대로 적는다.** 대화 세션이 역할을 겸했으면 작업 노트와 Run 기록에 그렇게 쓴다. T-0002 부터 Worker 는 Context 패킷(step.yaml 과 그 `inputs` 의 파일 경로)만 받은 별도 세션으로 실행한다.
- **Reviewer 에게 주는 것**: `roles/reviewer.md`, Task·Step 정의, 검토 대상 commit 과 diff 명령, 이전 Gate, Worker 의 작업 노트(특히 "확인하지 못한 것" — 지금까지 실제 결함은 모두 여기서 나왔다), deterministic 결과. "값싸게 확인할 수 있으면 실행해서 확인하라" 고 지시한다. 출력은 verdict / checks / done_when / comments(severity: defect·risk·note, class: A 승인 전 수정·B 후속·C 의견)의 JSON.
- Reviewer 에게 임시 파일을 쓰게 할 때는 **자신이 만든 디렉터리 하나만** 쓰고 그것만 지우게 한다.

## 기록하는 법

- 엔티티(yaml)는 `schemas/` 를 따른다. 이벤트는 직접 쓰지 말고 스크립트로 append 한다. seq 와 task_id 는 스크립트가 부여한다.
  ```
  cd C:\git\devflow
  npm run append-events -- C:\git\devflow-data\T-0001 <events.json>
  npm run validate-data -- C:\git\devflow-data
  ```
- **검증이 통과한 뒤에만 commit 한다.** PowerShell 에서는 `$ErrorActionPreference='Stop'` 을 걸고, 단계마다 `$LASTEXITCODE` 를 확인한다. 앞 단계가 실패했는데 commit·push 가 진행된 사고가 두 번 있었다.
- 운영에 쓰는 스크립트와 자료는 세션의 임시 폴더가 아니라 이 repo 의 `scripts/` 에 둔다. 임시 폴더는 다른 세션에서 보이지 않고 사라질 수 있다.
- commit 작성자는 두 repo 의 로컬 git 설정에 있다. 메시지 끝에 `Co-Authored-By` 줄을 붙인다. `devflow-data` 는 private repo 다.
- 상태 기록에 로컬 경로를 쓰지 않는다. 문서는 `artifact://…@vN`, 코드는 repo + branch + SHA.

## Task 를 끝낼 때

Planner 의 `done` 결정(AC 별 근거) → 사람의 최종 확인 → task branch 를 main 에 merge(또는 PR) → worktree 정리 → `docs/retro/T-NNNN.md` 작성(템플릿은 `retro/README.md`) → `roadmap.md` 의 체크리스트 갱신 → **Ledger 의 "후속 Task 후보" 와 회고의 개선 조치를 `devflow-data/backlog.md` 로 옮긴다.** Ledger 는 Task 와 함께 닫히므로 거기에만 적힌 것은 잊힌다.

## 다음에 무엇을 할지

`devflow-data/backlog.md` 에 Task 후보가 권고 순서와 이유와 함께 있다. 큰 방향과 단계 전환 기준은 `roadmap.md`. 새 Task 는 사람이 backlog 에서 골라 Intake 를 거쳐 발행한다.
