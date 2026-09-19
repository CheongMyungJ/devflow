# 0단계 수동 운영 절차

도구(Orchestrator, CLI)가 아직 없는 동안 AI 대화 세션이 Orchestrator 역할을 손으로 한다. **대화 세션이 하는 것은 Intake(사람과의 대화)와 Orchestrator(기록, 검증, 역할 세션의 실행, 사람에게 보고)뿐이다. Planner, Worker, Reviewer 는 모두 Context 패킷만 받은 별도 세션으로 실행한다**(T-0002 부터. 아래 "역할 세션을 실행하는 법"). 이 문서는 **어떤 세션이든 이것만 읽고 이어갈 수 있도록** 그 절차를 적는다. 구조와 용어는 `architecture.md`, 규칙은 `../AGENTS.md`.

## 위치

| 무엇 | 어디 |
|---|---|
| 시스템 repo (이 repo) | `C:\git\devflow` — main 에는 설계·스키마·역할 프롬프트·운영 스크립트 |
| Task 데이터 repo | `C:\git\devflow-data` — `T-NNNN/` 마다 task.yaml, ledger.md, events.jsonl, decisions/, steps/. 구조는 그 repo 의 README |
| Task 작업 공간 | `C:\git\devflow-worktrees\T-NNNN` — branch `task/T-NNNN-*` 의 worktree. `npm ci` 가 되어 있어야 한다. 시작 전에 typecheck·test 가 통과하는지 확인해 둔다 |
| 다른 repo 의 기준 상태 | Step 의 inputs 가 `code://<다른 프로젝트>@<sha>` 를 가리키면 그 SHA 의 detached worktree 를 따로 만들어 읽기 전용으로 준다(예 `C:\git\devflow-worktrees\T-NNNN-data-ro`). 작업 중인 checkout 을 주지 않는다 |

## 상태를 복원하는 법 (세션을 새로 시작했을 때)

1. `devflow-data/T-NNNN/ledger.md` — 승인된 Step 의 요약, 주요 결정, 진행 중인 것, 후속 Task 후보.
2. `devflow-data/T-NNNN/events.jsonl` 의 마지막 10~20줄 — 지금 어느 Step 이 어떤 상태인지. `step.status_changed` 의 마지막 `to` 가 현재 상태다.
3. 진행 중인 Step 의 `steps/step-NNN/` — `step.yaml`(정의), `gates/` 의 마지막 Gate, `runs/*.work-notes.md`(Worker 가 남긴 판단과 "확인하지 못한 것"), `feedback/`.
4. `git -C C:\git\devflow-data status` 와 `git -C <worktree> status` — commit 되지 않은 것이 있으면 이전 세션이 도중에 끊긴 것이다. 내용을 보고 이어 갈지 버릴지 정한다.
5. `run.submitted` 는 있는데 `run.completed` 가 없는 Run 은 이전 세션과 함께 사라진 실행이다(서브에이전트는 세션을 넘지 못한다). 그 Run 을 `run.failed` 로 기록하고 다시 실행한다.

### 대화 세션(Orchestrator)을 도중에 바꿀 때 (T-0004 — step-002 의 in_review 에서 한 번 성립했다)

떠나는 세션이 Ledger 에 **"세션 인계" 절**을 쓰고 commit 한다: 지금 기다리는 것(사람의 무엇을, 앞 세션의 권고는 무엇이었나) / 그다음에 할 일(어느 역할을 어떤 모델로, 패킷에 넣을 것) / done 때 사람에게 보일 것 / merge 뒤의 순서 / 사람이 "반드시" 라고 한 것 / 회고에 남길 관찰. 새 세션은 위 1~5 로 복원한 뒤 **사람에게 상태와 기다리던 요청을 다시 보여 주고 확인받는다 — 앞 세션에서 사람이 한 말은 기록된 승인이 아니다.** 이어받은 사실과 부족했던 것을 그 절에 덧붙인다. 역할 세션이 실행 중일 때는 바꾸지 않는 편이 낫다(결과를 잃는다 — 5번).
- (T-0005 에서 더함) 인계 절에 **데이터 repo 의 push 상태**(origin 보다 몇 commit 앞서 있는가)를 적는다.
- **새 세션이 이어받은 뒤 앞 세션은 기록을 쓰지 않는다.** T-0005 에서 인계 뒤에도 앞 세션이 사람과의 대화로 commit 을 하나 더 했다 — 새 세션이 역할 세션을 띄우기 직전에 데이터 repo 의 HEAD 를 다시 보아 잡았다. 새 세션은 상태를 보여 줄 때 "앞 세션에서는 더 쓰지 않는다" 를 사람에게 확인받고, 역할 세션을 띄우기 직전에 HEAD 가 복원 때와 같은지 본다.

### 역할 세션이 도중에 끊겼을 때 (T-0003 의 R-012 — 사용량 한도)

1. Workspace 의 `git status` 와 작업 노트의 유무를 본다. commit 되지 않은 변경이 있으면 `git diff` 를 `steps/step-NNN/runs/R-NNN.partial.diff` 로 저장한 **뒤에** Workspace 를 마지막 commit 으로 되돌린다. 세션이 남긴 임시 디렉터리는 지운다.
2. 경위를 `runs/R-NNN.failed.md` 에 적는다(무엇이 남아 있었고 어떻게 처리했는가. 끊긴 세션이 띄운 하위 세션의 결과가 뒤늦게 도착했으면 그 요지도 — 누구도 검증하지 않은 것임을 밝힌다).
3. Run 을 `status: failed` 로, `run.failed` 이벤트를 남긴다. 실제로 끊긴 시각은 알 수 없으므로 `at` 이 "기록한 시각" 임을 note 에 적는다.
4. 새 Run 으로 다시 실행한다. 패킷에 잔여물 두 파일을 "참고일 뿐이다 — 승인된 것도 검증된 것도 아니다" 로 넣는다. 버전을 만들지 못한 실행은 재작업 횟수로 세지 않는다.

## Task 를 발행할 때 (Intake — T-0004 부터 두 단계, ADR-0014)

대화 세션이 `roles/intake.md` 를 따라 한다. 요지만 적는다 — 기준은 그 파일과 `schemas/task.schema.json` 의 description 이다.

1. **의도 확인**: 7칸(문제 / 바라는 결과 / 식별 가능한 성공 기준 / 영향받는 사람과 시스템 / 제약 / 범위 밖 / 열린 질문)의 짧은 초안을 **AC 없이** 먼저 보여 주고 확인받는다. 모르는 것은 미리 묻지 말고 열린 질문 칸에 담당자(사람이 Intake 중에 / `planner_or_worker` / `investigation_step`)와 함께 적는다. 사람이 답할 질문에는 선택지와 권고를 붙이고, 무엇을 누가 지키게 되는지가 드러나게 쓴다(T-0004 의 Intake 에서 사람이 질문의 뜻을 되물었다 — intake.md 에는 아직 없다, backlog).
2. **정의 확인**: 1단계가 맞은 뒤에만 AC 와 `target.scope_hint` 를 쓰고 AC 마다 `covers` 를 적는다. 발행 전 되짚기(intake.md 2단계 3번)는 스키마가 못 보는 것이라 손으로 한다.
3. Task 정의에 다섯 칸(`problem`, `success_criteria`, `affected`, `non_goals`, `open_questions`)을 모두 적는다(없으면 빈 배열). 사람이 답할 질문이 남은 Task 는 스키마가 거부한다 — 오류 문장은 오타와 같으니 발행 전에 직접 확인한다. **범위 밖이나 맡긴 것을 constraints 에 끼워 넣지 않는다**(T-0002~T-0004 의 옛 기록은 그렇게 되어 있다. T-0004 는 의도 원문을 `intent.md` 로 따로 두었다 — 새 양식에서는 필요 없다).
4. Intake 의 경과(초안을 사람이 고쳤는가, 되물은 것, 왕복 횟수)를 Ledger 의 운영 메모에 남긴다 — 회고의 재료다.

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
  → 승인되면 승인 Feedback·이벤트, step closed, ledger.md 에 요약 추가 (Artifact meta 는 고치지 않는다 — T-0005 부터)
  → Planner 가 다음 행동 결정 (next_step / ask_human / done …)
```

- **`step.yaml` 의 `status` 를 전이마다 이벤트와 함께 고친다**(proposed → defined → running → checking → in_review → closed. 재작업이면 revising). T-0005 의 step-003 에서 새 대화 세션이 defined 에 둔 채 진행했다 — 이벤트만으로는 이 절차가 드러나지 않는다.
- **승인하되 다음 Step 에서 반드시 고칠 것**이 있으면(T-0005 의 F-005 — 재작업 대신 사람이 고른 길) 승인 Feedback 의 text 에 "다음 Step 에서 반드시 고칠 것" 과 그 범위를 적고, Planner 패킷에 그 Feedback 을 넣고, 다음 Step 의 Worker·Reviewer 패킷에도 경로를 넣는다(아래 "사람의 Feedback 이 완료 조건을 바꾸면" 과 같다). 스키마에 자리가 없다(backlog).
- **승인을 기록하는 순서**(T-0004 에서 새 대화 세션이 앞 Step 의 기록을 보고 찾아야 했다): 산출물마다 승인 Feedback 하나(`steps/step-NNN/feedback/F-NNN.yaml`, `kind: approval`, `target.artifact_ref` 에 버전까지, text 에 사람의 말과 받아들인 권고·한계) → `step.yaml` 의 `status: closed` → 이벤트: `feedback.added`(산출물마다) → `artifact.approved`(산출물마다, `data.gate`) → `step.status_changed` in_review→approved(`data.official_gate`) → approved→closed → `ledger.updated`. **Artifact meta 는 쓴 뒤 고치지 않는다**(T-0005 의 F-001 (A), ADR-0015 — 승인은 승인 Feedback 과 `artifact.approved` 이벤트로만 판단한다. artifact 스키마의 `approved` 는 옛 기록을 읽기 위한 필드이고 새 meta 에는 쓰지 않는다. T-0005 까지의 기록은 옛 절차대로 `approved: true` 로 고쳤다).
- **Artifact meta 를 쓰는 법**(T-0005 부터 `validate-data` 가 검사한다 — F9): 문서는 `stored_in: store` + `content_key: blob:T-NNNN/step-NNN/R-NNN.<label>`(Store 의 key 문법 — store.md 3.3), 코드는 `type: code_change` + `code`(repo, branch, base_sha, head_sha), 대상 repo 안의 문서라면 `stored_in: repo` + `code` + `paths`(repo 상대 경로). `approved` 는 쓰지 않는다.
- **Ledger 의 Step 요약에는 세 가지를 적는다**: 무엇이 승인되었나(산출물 참조, 내용, 검증, 경과) / **뒤의 Step 이 알아야 할 것** / **상세가 있는 곳**(어느 Artifact 의 어느 절, 어느 Gate). 요약만 있고 상세의 위치가 없으면 다음 Planner 가 헤맨다(T-0003 의 R-006 → 고친 뒤 R-009, R-015 는 "다음 행동은 Ledger 만으로 정해졌다"). "진행 중" 절에 옛 줄을 남기지 않는다. 뒤로 넘기는 지적은 나올 때마다 Ledger 의 "후속 Task 후보" 에도 적는다(T-0003 에서는 끝까지 비어 있었다).
- **누가 수행했는지 사실대로 적는다.** Ledger 의 운영 메모에 수행 주체를 적는다. 대화 세션이 역할을 겸한 일이 있으면(T-0001 이 그랬다) 그렇게 쓴다.
- **Reviewer 에게 주는 것**: `roles/reviewer.md`, Task·Step 정의, 검토 대상 commit 과 diff 명령, 이전 Gate, Worker 의 작업 노트(특히 "확인하지 못한 것" — 지금까지 실제 결함은 모두 여기서 나왔다), deterministic 결과. 확인하는 방법("실행해서 확인", "'확인하지 못한 것' 을 먼저 공격", 임시 디렉터리 하나, 고쳐 보는 확인은 복사본에서)과 출력의 형식은 T-0003 부터 `roles/reviewer.md` 에 있다 — **패킷에 다시 쓰지 않는다. 패킷이 지침과 다른 형식을 말하면 출력이 거부된다**(아래 "Reviewer 출력의 형식").
- **사람이 승인하지 않고 수정을 요청하면** Feedback 에 무엇을 고치고 무엇은 대상이 아닌지, 완료 조건을 바꾸는지 더하는지를 적는다. 재작업은 새 Worker 세션이고, 그 뒤의 Reviewer 도 새 세션이다. Reviewer 의 pass 와 사람의 판단이 다를 수 있다 — 그것이 검증의 독립성이다(T-0003 에서 세 Step 중 둘이 "pass 인데 수정 요청" 이었다).
- **사람에게 검토를 요청할 때**는 Gate 의 용어를 그대로 옮기지 않는다. "무엇이 바뀌었나 / 무엇을 정해야 하나 / 내 권고" 를 쉬운 말로 먼저 쓰고, 상세는 그 뒤에 둔다.
- 사람의 Feedback 이 Step 의 done_when 이나 Task 의 AC 의 문구를 바꾸면(스키마에 반영할 자리가 아직 없다) Feedback 에 "무엇에 우선하는지" 를 적고, 이후의 Worker·Reviewer·Planner 패킷에 그 Feedback 을 넣는다.

## 역할 세션을 실행하는 법

서브에이전트(또는 `claude -p`)를 **새로** 띄운다. 같은 역할의 두 번째 실행도 앞 실행을 이어가지 않는다 — 작업 노트와 기록만으로 이어받을 수 있는지가 시험 대상이다. 프롬프트에는 대화의 맥락을 풀어 쓰지 않고 아래 틀만 채운다. **결과가 나쁘면 패킷을 몰래 보강하지 않는다. 그것이 Step 정의·Ledger·스키마의 부족을 드러내는 정보이므로 Ledger 와 회고에 적는다.**

```
당신은 devflow 의 <역할> 세션이다 (Run R-NNN, Task T-NNNN[, Step step-NNN][, 재작업]). 이전 세션의 기억은 없다.
이 프롬프트에 없는 맥락은 주어지지 않는다. 패킷의 파일과 거기서 참조되는 파일에서 직접 확인하라.

## Context 패킷
- 역할 지침: roles/<역할>.md 의 경로
- Task 정의(새 양식이면 의도의 칸 — problem, success_criteria, affected, non_goals, open_questions — 이 그 안에 있다. 역할 지침이 읽는 법을 말한다), (Planner) Ledger, (Worker·Reviewer) Step 정의의 경로
- Step 의 inputs: 참조 → 로컬 위치 (task.brief → task.yaml, code://<repo>@<sha> → worktree 또는 읽기 전용 clone. 기준은 SHA 다)
- (Planner) 직전 Step 의 공식 Gate, Feedback, 이전 Decision, Skill 카탈로그(지금은 비어 있다), 남은 한도
- (재작업 Worker) 이전 버전의 commit 과 meta, 이전 실행의 작업 노트, Feedback, Gate
- (Reviewer) 검증 대상 Artifact 의 commit 과 diff 명령, 작업 노트, 시스템의 deterministic 결과, 이전 Gate, 재작업이면 Feedback
- (Worker·Reviewer) 사람의 Feedback 가운데 이 Step 의 완료 조건을 바꾸거나 더한 것의 경로(Step 의 inputs 로 가리킬 수 없다)
- verify 에 서술로 적힌 검사가 있으면 그 실제 명령
- (Worker·Reviewer) 실행 중 사람이 준 지시: 없으면 "없음"

- artifact 참조에서 본문을 찾는 법(meta 는 steps/<step>/artifacts/<name>/vN.meta.yaml, 문서 본문은 meta 의 content_key 가 가리키는 runs/ 의 파일, 코드는 meta 의 code)

## 출력
- 출력 파일의 경로 하나(아래 표). 형식은 역할 지침의 "출력" 절과 그것이 가리키는 스키마를 따른다 — 패킷에 형식을 다시 쓰지 않는다.
  시각은 추정하지 말고 얻어서 적는다. 로컬 경로를 쓰지 않는다.
- `packet_gaps` 는 출력의 정식 필드다(문장의 배열, 부족한 것이 없었으면 빈 배열 `[]`). Planner 에게는 "Ledger 만으로 충분했던 것 / 부족해 다른 파일을 읽은 것" 을 나눠 적게 한다.
- (Worker) commit 은 task branch 에, 이전 commit 을 고쳐 쓰지 않는다, push 하지 않는다. 작업 노트의 경로. **작업 노트를 끝에 몰아 쓰지 말고 commit 직후에 먼저 쓰고 확인 결과를 덧붙이게 한다**(세션이 끊겨도 commit 과 노트가 남도록 — T-0003 의 R-012).
  작업 노트의 맨 위에 summary 절(Ledger 에 들어갈 3~5줄). 마지막 응답에 commit SHA 와 끝낸 시각.
- (재작업의 Reviewer) 판정 대상은 새 버전 전체다. 작업 노트가 재작업분만 담고 있으면 앞 버전의 노트와 합쳐 판정한다고 적는다.
- "프롬프트(또는 문서) 하나만 보고 해 본다" 같은 깨끗한 실험이 필요하면 **읽는 순서를 패킷에 적는다** — 다른 파일을 열기 전에 먼저 하게 한다(T-0003 의 R-014).

## 금지
- 출력 파일(과 Worker 의 Workspace, 자신이 OS 의 임시 위치에 만들고 스스로 지우는 디렉터리 하나) 외에는 아무것도 만들거나 고치지 않는다. 스스로 승인하지 않는다. 다음 Step 을 정하지 않는다.
- (Task 가 시스템 repo 의 스크립트를 고치는 경우) task branch 의 스크립트를 실제 데이터 repo 에 대고 실행하지 않는다.
```

- **패킷의 원문을 Run 옆에 `R-NNN.packet.md` 로 남긴다**(T-0005 의 R-007 부터 — Task 수준 Run 은 `T-NNNN/runs/`, Step 수준은 `steps/step-NNN/runs/`). 대화 세션이 바뀌면 앞 세션이 실제로 무엇을 주었는지 알 길이 없어 "같은 틀" 을 다시 짜야 했다. `validate-data` 와 Store 는 이 파일을 blob(`R-NNN.packet`)으로 읽고 Run 으로 세지 않는다.
- Task 의 산출물을 **실행해 보는** 역할 세션(Reviewer, done 의 Planner)에게는 빌드물이 어디 있는지 말해 주면 헤매지 않는다 — Workspace 의 `node_modules/.cache/devflow-test-build`(npm test 의 global setup 이 만든다, git 이 무시한다)는 HEAD 의 빌드다. OS 임시 위치에 빌드하면 의존성과 `schemas/` 를 찾지 못하고, node_modules 를 링크로 잇는 것은 금지다(T-0005 의 R-008·R-012 packet_gaps).
- 대소문자를 가리는 파일 시스템에서 확인해야 하면(Windows 는 기본이 가리지 않는다) OS 임시 위치의 빈 디렉터리에 `fsutil file setCaseSensitiveInfo <dir> enable` 을 켠다 — 관리자 권한 없이 된다(T-0005 의 R-011·R-012).

역할 세션이 따르는 지침과 고치는 대상이 같은 파일일 때(역할 프롬프트를 고치는 Task)는 "당신이 따를 지침은 기준 SHA 의 것이고 고치는(검증하는) 대상은 Workspace 안의 것이다" 를 패킷에 적는다.

### Reviewer 출력의 형식 (T-0003 부터)

기준은 `roles/reviewer.md` 의 "출력" 절과 `schemas/reviewer-output.schema.json` 이다. 최상위는 `verdict`, `checks`, `done_when`, `comments`, `packet_gaps` 다섯뿐이고, `comments` 는 `{severity, class, text}` 의 **객체 배열**이다(문장으로 쓰지 않는다. `[severity / class]` 로 시작하는 문장은 T-0003 까지의 옛 형식이고 `record-gate` 가 거부한다). class A 가 하나라도 있으면 verdict 는 fail 이어야 한다(어기면 거부). 출력 파일은 BOM 없는 UTF-8 JSON.
T-0001~T-0003 의 Gate 는 옛 형식(문장 comments)으로 남아 있고 스키마가 옛 기록으로서 받아 준다.

| 역할 | 출력 파일 | 반영 |
|---|---|---|
| Planner | `T-NNNN/runs/R-NNN.output.yaml` (Decision) | `decisions/D-NNN.yaml` 로 복사 → `npm run propose-step -- <task-dir> D-NNN step-NNN` |
| Worker | task branch 의 commit + `steps/step-NNN/runs/R-NNN.work-notes.md` | Orchestrator 가 deterministic 검사를 직접 다시 실행하고 `gates/G-NNN.deterministic.md` 에 적는다. `artifacts/<name>/vN.meta.yaml` 작성 |
| Reviewer | `steps/step-NNN/runs/R-NNN.output.json` | `npm run record-gate -- <task-dir> step-NNN G-NNN R-NNN <artifact-ref,…> [--annotations <file>]` |

`record-gate` 는 Reviewer 출력을 스키마로 검증하고, 맞지 않으면 `REJECTED` 와 오류의 위치를 출력하고 아무것도 쓰지 않는다(exit 1). 받아들이면 Reviewer 의 `packet_gaps` 를 **그 Reviewer 의 Run 기록 끝에 덧붙이고** Gate 를 쓴다. 상세는 스크립트 머리의 주석.
- **거부되면**: 출력 파일을 손으로 고치지 않는다. 같은 Reviewer 세션에게 오류 메시지를 주어 출력을 다시 쓰게 하거나(이어갈 수 있으면), 안 되면 새 Reviewer Run 으로 다시 실행한다. 다시 받은 횟수를 Run 의 `output_attempts` 에 적는다.
- **Run 을 닫을 때(`status: completed`, `ended_at`) `record-gate` 가 덧붙인 `packet_gaps` 를 지우지 않는다.** 순서는 record-gate → Run 닫기. Run 파일은 줄 단위로 고치고 통째로 다시 쓰지 않는다.
- Worker 와 Planner 의 `packet_gaps` 를 Run 으로 옮기는 도구는 아직 없다 — Orchestrator 가 Run 기록에 `packet_gaps:` 로 손으로 옮긴다(Worker 의 것은 작업 노트의 packet_gaps 절에서, Planner 의 것은 Decision 의 `packet_gaps` 에서).
- `--annotations` 의 입력 파일(시스템 기록, Worker 의 실측을 Gate 에 덧붙일 때)은 `steps/step-NNN/gates/G-NNN.annotations.json` 으로 둔다. (T-0005 부터 `validate-data` 는 gates/ 의 `G-NNN.yaml` 만 Gate 로 읽으므로 `.yaml` 이어도 실패하지 않는다. Store 는 둘 다 Gate 의 blob 으로 읽는다. 지금까지의 기록과 같게 `.json` 을 쓴다.)
- gate id 는 `G-NNN` 의 모양으로 정확히 준다. 스크립트가 아직 모양을 검사하지 않아, 파일 이름이 될 수 없는 id 를 주면 Run 만 고쳐진 채 죽는다(같은 명령을 올바른 id 로 다시 돌리면 끝난다 — backlog).
- Run 기록에 수행 주체를 적는다: `performer: isolated_session`(Context 패킷만 받은 독립 세션) | `conversation_session`(대화 세션이 역할을 겸함).

Run 기록은 세션을 띄우기 **전에** `status: submitted` 로 쓰고(`run.submitted`), 끝나면 `completed` 로 바꾼다. `submitted` 상태의 Run 에는 `output_attempts` 를 적지 않는다(스키마는 1 이상만 받는다). Step 에 속하지 않는 Run(Planner)은 `T-NNNN/runs/` 에 둔다. `run.submitted` 의 note 에 "대화 세션이 끝나면 결과를 잃는다" 를 적어 둔다. 반영은 항상 `validate-data` 를 통과한 뒤에 한다 — 역할 세션의 출력은 제안이다(AGENTS.md 6·13번).

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
- 운영에 쓰는 스크립트와 자료는 세션의 임시 폴더가 아니라 이 repo 의 `scripts/` 에 둔다. 임시 폴더는 다른 세션에서 보이지 않고 사라질 수 있다. 지금 있는 것: `append-events`, `validate-data`, `propose-step`, `record-gate`. 검증용으로 `check-store-read`(T-0005 — 데이터 repo 의 checkout 을 Store 로 열어 모든 kind 를 읽어 본다: `npm run check-store-read -- <checkout>`. tsc 빌드를 `node_modules/.cache` 에 만들고 지운다).
- **`validate-data` 가 검사하는 것**(T-0005 부터): Task·Step·Decision·Feedback·Gate·Run·이벤트에 더해 Artifact meta(`steps/<step>/artifacts/<name>/v<N>.meta.yaml`). 이름 규칙은 Store 의 list 와 같다 — decisions/ 는 `D-NNN.yaml`, feedback/ 는 `F-NNN.yaml`, gates/ 는 `G-NNN.yaml`, runs/ 는 `R-NNN.yaml` 만 그 kind 로 읽고 나머지 파일(`.work-notes.md`, `.output.*`, `.packet.md`, `.deterministic.md` 등)은 세지 않는다. 스키마는 `src/schema/registry.mjs` 하나로 읽는다(ADR-0016).
- **Store(T-0005)가 생겼지만 0단계의 기록은 아직 손으로 쓴다** — 운영 스크립트를 Store 위로 옮기는 것은 T-0005 의 범위 밖이었다(backlog). Store 가 쓰는 배치는 지금 손으로 쓰는 배치와 같다(store.md 3.1·3.3).
- **Task 가 진행되는 동안에는 이 repo 의 main 에 운영 스크립트를 commit 하지 않는다**(역할 세션이 보는 clone 의 HEAD 가 움직여 검증의 기준 SHA 가 흔들린다 — T-0002). 대상 repo 가 이 repo 인 Task 라면 더욱 그렇다. 꼭 필요하면 Ledger 에 적는다.
- commit 작성자는 두 repo 의 로컬 git 설정에 있다. 메시지 끝에 `Co-Authored-By` 줄을 붙인다. `devflow-data` 는 private repo 다.
- 상태 기록에 로컬 경로를 쓰지 않는다. 문서는 `artifact://…@vN`, 코드는 repo + branch + SHA.

## Task 를 끝낼 때

Planner 의 `done` 결정(AC 별 근거 — Planner 에게 AC 의 검사 명령을 주어 최종 commit 에서 직접 다시 확인하게 한다. '데이터 repo 의 모든 Task' 같은 AC 는 그때의 데이터 repo HEAD 로 읽기 전용 checkout 을 새로 만들어 준다. 패킷에 '새 세션을 띄우지 않는다' 를 넣는다) → 사람의 최종 확인(AC 만이 아니라 **Intake 때 사람이 원한다고 한 것과 대조**해 보여 준다 — Task 의 `success_criteria` 원문(옛 양식이면 의도 확인 원문) 한 줄마다 결과와 남는 한계를 나란히. Planner 의 done 은 AC 만 본다) → task branch 를 main 에 merge(또는 PR) → merge 뒤 main 에서 typecheck·test·validate-data → `task.yaml` 의 `status: done` 과 `task.done` 이벤트(`data.merge` 에 merge SHA, `data.post_merge_check`, 이 이벤트부터 `system_sha` 는 merge 뒤의 main) → **Task 가 이 repo 의 운영 도구·역할 지침·스키마를 바꿨으면 merge 직후에 이 문서를 고친다**(Task 밖의 운영 commit. 안 고치면 다음 세션이 옛 틀로 패킷을 쓴다) → worktree 정리 → `docs/retro/T-NNNN.md` 작성(템플릿은 `retro/README.md`) → `roadmap.md` 의 체크리스트 갱신 → **Ledger 의 "후속 Task 후보" 와 회고의 개선 조치를 `devflow-data/backlog.md` 로 옮긴다.** Ledger 는 Task 와 함께 닫히므로 거기에만 적힌 것은 잊힌다.

## 다음에 무엇을 할지

`devflow-data/backlog.md` 에 Task 후보가 권고 순서와 이유와 함께 있다. 큰 방향과 단계 전환 기준은 `roadmap.md`. 새 Task 는 사람이 backlog 에서 골라 Intake 를 거쳐 발행한다.
