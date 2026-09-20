# 0단계 수동 운영 절차

T-0006 뒤의 절차다. 대화 세션은 **Intake와 Orchestrator(기록, 검증, 역할 실행, 사람에게 보고)**를 맡고 Planner·Worker·Reviewer는 Context 패킷을 받은 별도 세션으로 실행한다. 실행과 판단 연결은 수동이지만, Task·Step·Run·Gate·승인 기록은 Store 위의 command로 쓴다. 구조는 `architecture.md`, 제약은 `../AGENTS.md`, 명령의 계약은 `design/commands.md` 6·7절과 `scripts/*.mjs` 머리 주석이 기준이다.

**새 도구는 Ledger를 쓰지 않는다.** Orchestrator가 편집 도구로 Ledger를 쓰고 `append-events`로 `ledger.updated`를 남긴다. 승인 명령 뒤에도 Ledger 요약을 따로 쓴다. Store commit과 git commit은 다르다. git commit·push는 아직 자동화되지 않았다.

T-0006 자체의 기록은 예외로 끝까지 기준 SHA `18fb89e`의 옛 스크립트·수동 YAML을 썼다. merge 뒤에는 그 SHA의 별도 checkout을 사용했다. 옛 절차는 `git show 18fb89e:docs/stage0-manual-operation.md`로 읽는다. **T-0007부터 아래 새 명령을 쓴다.** T-0006 merge 후 보완은 사람이 명시적으로 Planner·Reviewer 생략과 Codex 직접 수정을 지시한 예외이며 일반 역할 분리 규칙을 바꾼 것은 아니다.

## 위치와 기록 규칙

| 무엇 | 위치·규칙 |
|---|---|
| 시스템 repo | `C:\git\devflow` — 운영 명령은 승인된 버전에서 실행 |
| 데이터 repo | `C:\git\devflow-data` — `<data-dir>`는 이 루트이며 Task 폴더가 아님 |
| Task 작업 공간 | `C:\git\devflow-worktrees\T-NNNN` — Task당 repo 하나·worktree 하나. 역할 세션과 Gate의 cwd |
| 다른 repo 입력 | `code://<repo>@<sha>`에 맞는 detached worktree를 따로 만들어 읽기 전용 제공 |
| 실행별 입출력 | 데이터 디렉터리 밖의 Run별 위치. 패킷·출력·노트·검증 결과를 받고 command가 정식 blob으로 저장 |

- 기록 명령은 대부분 `<data-dir> <task-id>`가 앞 인자다. **`issue-task`는 `<data-dir> <definition.yaml>`**, 검증 명령은 데이터 루트 하나다. 옛 `<task-dir>` 호출은 사용법 오류다.
- ID·시각·status·system_sha·이벤트 seq·commit_id는 도구가 채운다. 입력으로 주지 않는다. Planner 출력의 식별 필드는 수용 시 도구가 채우고 원문은 보존한다.
- 사람의 행동 명령(`issue-task`, `define-step`, `request-revision`, `add-feedback`, `approve-step`, `complete-task`)에는 `--actor human:<id>`가 필수다. 시스템·역할 기록 명령에는 주지 않는다. `append-events`만 선택으로 받는다.
- PowerShell에서는 단계마다 `$LASTEXITCODE`를 확인한다. 실패하면 후속 기록·commit·push를 하지 않는다. 입력 거부는 exit 1, 사용법 오류는 exit 2다. 예외·결과 불명 오류는 성공으로 취급하거나 무작정 재실행하지 말고 기록과 git 상태를 먼저 확인한다.
- **validate-data 통과 뒤에만 git commit한다.** 작성자는 각 repo의 로컬 git 설정, `Co-Authored-By`는 실제 도구를 쓴다. 숫자는 세고, 운영 메모의 시각도 시계에서 얻는다.
- **Ledger와 예외적인 수동 YAML은 파일 편집으로 고친다. 문자열 치환 스크립트로 고치지 않는다.** 성립한 이벤트는 틀렸어도 수정·삭제하지 않는다. 허용된 후속 기록에 원래 seq와 정정 내용을 남긴다.
- 상태 기록은 artifact 참조 또는 repo·branch·SHA로 연결한다. 입구에 준 로컬 파일 경로는 기록되지 않는다. 패킷의 실행용 로컬 매핑과 출력·상태 참조를 구별하며 CLI 로그의 비밀·로컬 경로를 상태 기록으로 복사하지 않는다.

## 상태를 복원하는 법

1. `ledger.md`의 승인된 Step·진행 중·세션 인계를 읽는다.
2. `events.jsonl` 마지막 10~20줄을 읽는다. Step status는 마지막 `step.status_changed.to`, 아직 없으면 `step.proposed`의 proposed다.
3. 현재 `step.yaml`, 최신 Gate, Artifact 버전과 작업 노트, Feedback을 대조한다. 승인은 Feedback과 `artifact.approved` 이벤트로 본다. meta는 승인 때 고치지 않는다.
4. 시스템·데이터 repo·Task worktree의 HEAD와 git status를 확인한다. 미commit 변경은 내용을 보고 이어받는다. 버리지 않는다.
5. submitted Run이 있으면 **실제 프로세스와 launch·completion·stdout·stderr·역할 출력 파일부터 확인한다.** 대화 턴 종료는 detached 프로세스의 종료가 아니다. PID의 생성 시각·경로로 재사용을 구별하고 중복 실행하지 않는다. 실행도 유효한 완료 출력도 없을 때만 실패 절차를 따른다.

### 대화 세션(Orchestrator)을 도중에 바꿀 때

떠나는 세션은 Ledger에 지금 기다리는 승인·버전 / 다음 역할·모델·패킷 / 실행 중 프로세스와 복원 기록의 위치 / done 때 보일 것 / merge 뒤 순서 / 사람이 "반드시"라고 한 것 / 회고 관찰 / 데이터 repo push 상태(실측 commit 수)를 적고 commit한다.

새 세션은 위 순서로 복원하고 상태와 다음 행동을 사람에게 보인다. **앞 세션은 더 기록하지 않는지 확인한다. 앞 세션의 대화 발언을 기록된 승인으로 간주하지 않는다.** 이미 이벤트로 남은 승인은 유지한다. 역할 실행 직전 데이터 HEAD가 복원 때와 같은지 본다. 이어받은 주체, 읽은 것, 부족했던 것을 인계 절에 덧붙인다. 실행 중 교대는 가급적 피하되 교대했다는 이유만으로 살아 있는 Run을 failed로 바꾸지 않는다.

## Task 발행 — Intake 두 단계

`roles/intake.md`를 따른다. 먼저 문제 / 바라는 결과 / 식별 가능한 성공 기준 / 영향받는 사람과 시스템 / 제약 / 범위 밖 / 열린 질문의 초안을 **AC 없이** 보여 확인받는다. 열린 질문에는 담당자를 적고 사람이 답할 것은 선택지와 권고를 붙인다.

확인 뒤 AC·scope_hint와 AC별 covers를 쓰고 의도에서 빠진 성공 기준이나 번역 중 생긴 요구가 없는지 되짚는다. 사람이 답할 질문이 남으면 발행하지 않는다. 범위 밖이나 역할에 맡긴 질문을 constraints에 끼워 넣지 않는다. 데이터 밖 정의 파일에는 `id`, `status`, `created_at`, `created_by`, `target.task_branch`를 넣지 않는다.

`npm run issue-task -- <data-dir> <definition.yaml> --slug <slug> --actor human:<id>`로 발행한다. 필요하면 출처·경위를 `--backlog`, `--intake`, `--note`로 준다. `target.base_branch`를 생략하면 등록된 원격의 기본 branch를 조회한다. 이름만 주면 원격 기준이고 로컬 branch를 쓰려면 `target.base_source: local`을 함께 준다. 반환된 ID로 아래 명령을 사용해 worktree를 준비하고, 의존성 설치 뒤 초기 typecheck·test를 확인한다. Intake에서 고친 것·되물은 것·왕복 경과를 Ledger 운영 메모에 남긴다.

Workspace 실행 설정은 데이터 repo 밖의 머신 파일로 둔다. 스키마가 정의하는 설정의 예:

```yaml
# <data-dir>/projects.yaml (공유)
projects:
  example:
    repo: https://example.com/team/example.git
```

```yaml
# 머신의 workspace.yaml (공유 데이터 밖, 경로는 이 파일 기준)
projects:
  example:
    clone: ./repos/example
    worktree_root: ./worktrees/example
    remote: origin
```

```sh
npm run prepare-workspace -- <data-dir> <task-id> --machine-config <workspace.yaml>
npm run workspace-status -- <data-dir> <task-id> --machine-config <workspace.yaml>
```

`DEVFLOW_MACHINE_CONFIG` 환경 변수로 머신 파일을 지정해도 된다. remote 기준의 최초 준비는 반드시 fetch하며, 최신은 그때 관찰한 commit이다. 재호출은 기록한 SHA와 작업공간을 재사용한다. 조회는 `unprepared` / `pending` / `pending_record` / `ready` / `blocked`를 표시한다. `pending_record`는 정상 작업공간은 있고 완료 이벤트만 없는 경우다. `pending`과 `pending_record`는 같은 준비 명령으로 이어간다. 실제 실행 경로는 명령 결과에만 표시되며 상태 기록에 넣지 않는다.

오류가 "준비 기록 또는 Git 작업이 남아 있을 수 있다"고 말하면 작업공간을 지우고 다시 시작하지 않는다. 겹친 실행은 기다리지 않고 멈춘다. 잠금이 남았으면 안내된 파일을 지우기 전에 관련 devflow/Git 프로세스가 모두 종료됐는지 확인해야 한다. 잠금 자동 회수는 없다. 부분 checkout·손상된 소유 기록·다른 branch로 바뀐 작업공간은 수동 확인 대상이다. `base_source`가 없는 옛 Task는 출처를 추정하지 않으므로 자동 준비하지 않는다.

## 한 Step의 절차

아래 입력 파일은 데이터 디렉터리 밖에 준비한다. `<run>`, `<step>`, `<gate>`는 실제 ID로 바꾼다. 패킷에 미리 쓴 Run ID는 `submit-run --expect-id`로 맞는지 검사한다.

| 순서 | 명령과 결과 |
|---|---|
| Planner 제출 | `npm run submit-run -- <data-dir> <task-id> --role planner --access read --backend claude-code --model claude-opus-5 --session-path new --performer isolated_session --expect-id <run> --packet <packet.md>` → Run·패킷 기록 뒤 별도 세션 실행 |
| Planner 출력 수용 | `npm run propose-step -- <data-dir> <task-id> <run> <output.yaml>` → Decision·원문·Run 완료. next_step이면 Step proposed |
| 사람 Step 확정 | `npm run define-step -- <data-dir> <task-id> <step> --actor human:<id>` → defined. 고쳤으면 `--edited <definition.yaml>`(도구 필드 제외). human_edit는 도구가 비교 |
| Worker 제출 | `npm run submit-run -- <data-dir> <task-id> --role worker --access write --backend claude-code --model claude-opus-5 --session-path new --performer isolated_session --step <step> --expect-id <run> --packet <packet.md>` → defined라면 running |
| Worker 출력 수용 | `npm run complete-run -- <data-dir> <task-id> <run> --worker-output <output.json> --work-notes <notes.md> --artifact <code-name>=code:<base-sha>..<head-sha> --artifact <notes-name>=blob:work-notes` → Run 완료·출력·노트·meta·checking을 함께 기록 |
| deterministic 검사 | Orchestrator가 Task worktree에서 verify 명령을 직접 실행하고 결과를 데이터 밖에 기록. 노트와 함께 Reviewer에게 제공 |
| Reviewer 제출 | `npm run submit-run -- <data-dir> <task-id> --role reviewer --access read --backend codex --model gpt-6-astra --session-path new --performer isolated_session --step <step> --expect-id <run> --packet <packet.md>` → 항상 새 독립 세션 |
| Gate 수용 | `npm run record-gate -- <data-dir> <task-id> <step> <gate> <run> <artifact-ref,…> --output <output.json> --deterministic <deterministic.md>` → Gate·Run 완료·packet_gaps·검증 blob·status를 함께 기록. pass면 in_review, fail이면 revising |
| 재작업 | fail이면 한도 안에서 새 Worker. 이전 HEAD·commit 보존, 추가 commit으로 수정. 새 Reviewer가 새 버전 전체를 검토 |
| 사람 승인 | `npm run approve-step -- <data-dir> <task-id> <step> --gate <gate> --text-file <approval.txt> --actor human:<id>` → Gate가 가리킨 각 최신 버전의 승인 Feedback·이벤트와 closed |
| 사람 수정 요청 | `npm run request-revision -- <data-dir> <task-id> <step> <artifact-ref> --text-file <request.txt> --actor human:<id>` → Feedback·revising 뒤 새 Worker |

- Artifact 이름은 Step outputs와 같고 모두 한 번씩 준다. 출처는 코드 `code:<base>..<head>`, repo 문서 `repo:<base>..<head>:<path>[,<path>…]`, 노트 `blob:work-notes`다. **최종 데이터 위치에 출력·meta·검증 파일을 먼저 두지 않는다.** 같은 내용이어도 blob 덮어쓰기는 거부된다.
- Reviewer 출력은 `schemas/reviewer-output.schema.json`의 UTF-8 JSON이다. 패킷에 형식을 다시 정의하지 않는다. A가 있으면 fail이어야 한다. Reviewer 아닌 출처의 보충은 `--annotations <file>`의 `{source, text, ref?}` 배열(빈 배열 불가)로 준다.
- 출력 거부 시 Orchestrator가 원문을 고치지 않는다. 오류를 역할에 돌려 다시 받고 `--output-attempts <n>`으로 횟수를 기록한다. 이어갈 수 없으면 새 Run·패킷으로 받는다. 출력 형식 재시도와 재작업은 구별한다.
- 사람 검토 요청은 **무엇이 바뀌었나 / 정해야 할 것 / 권고**를 먼저 쉬운 말로 보인다. 산출물 내용·버전·한계를 설명하고 Gate pass라도 개별 fail 검사와 B·C를 숨기지 않는다.
- **승인 명령 뒤 Ledger 요약을 따로 쓴다**: 승인 참조·내용·검증·경과 / 뒤가 알아야 할 것 / 상세 위치. 진행 중에 과거 대기를 남기지 않는다. 후속 지적도 즉시 후보에 적는다. 다음 행동은 새 Planner에게 맡긴다.
- "승인하되 다음 Step에서 반드시"는 승인 text에 범위를 적는다. 완료 조건을 바꾼 Feedback도 무엇에 우선하는지 적고 이후 Planner·Worker·Reviewer 패킷에 원문을 넣는다. 아직 정식 필드가 없다.
- intake Run 완료, 제안 취소(cancelStep), task.aborted·run.cancelled command는 아직 없다. 필요하면 지원 공백을 알리고 기록 방법을 정한다. `append-events`로 status 전이를 흉내 내지 않는다.

## 역할 세션 실행과 Context 패킷

Planner·Worker는 `claude -p` 새 프로세스로, cwd는 **Task worktree**다. 현재 사람 지정은 claude-opus-5, Reviewer는 별도 Codex CLI gpt-6-astra 새 세션이다. Task별 명시적 사용자 지정이 우선한다. **resume 일반 정책은 아직 정하지 않았다.** 요청으로 사용할 때도 실패 시 새 패킷 세션 경로를 준비한다.

Claude 실행은 `claude -p --model claude-opus-5 --output-format json --add-dir <필요한 폴더들>`에 패킷을 stdin으로 보낸다. Codex는 `codex exec --model gpt-6-astra --cd <Task-worktree> --json --color never -`에 보낸다. 권한·sandbox 옵션은 실제 허용 범위에 맞춘다. T-0006에서는 승인된 네트워크·폴더 쓰기 환경에서 Claude의 `--dangerously-skip-permissions`, Codex의 `--sandbox danger-full-access -c approval_policy="never"`를 사용했다. 권한 때문에 막히면 보고하고 우회하지 않는다.

긴 실행을 한 셸 호출로 붙잡지 않는다. 숨긴 감독 프로세스에서 stdout·stderr를 파일로 받고 launch에 PID·생성 시각·cwd·모델·시작·제한 시각, completion에 실제 종료 시각·exit code·timeout을 쓴다. Worker 최대 120분, Planner 30분·Reviewer 60분을 운영 기본값으로 하되 실행 전에 설명한다. 제한을 넘으면 해당 자식 프로세스 트리만 종료한다. 짧은 조회로 프로세스·파일·역할 출력을 확인하며 정상 변화 없는 반복 알림은 하지 않는다. JSON stdout은 끝날 때까지 비어 있을 수 있다.

종료 뒤 실제 모델·cwd·session id와 기록 불변을 확인한다. 현재 command에는 종료 뒤 backend_session_id·CLI 로그를 자동 수용하는 전용 입구가 없다. 로그를 Run과 연결해 보존하고 `--note`·Ledger에 위치 독립 요약을 남긴다. 역할 출력 파일과 backend stdout은 서로 다르다. 이 공백은 Runner 후속이며 Run 필드를 몰래 고치지 않는다.

패킷은 다음 틀을 쓴다. 부족해서 결과가 나쁘면 몰래 보강하지 말고 부족함을 Ledger·회고에 남긴다.

```text
당신은 devflow의 <역할> 세션이다 (Run <id>, Task <id>[, Step <id>][, 재작업]). 이전 세션의 기억은 없다.
이 프롬프트에 없는 맥락은 주어지지 않는다. 패킷의 파일과 그 참조에서 직접 확인하라.

Context 패킷:
- 기준 SHA의 roles/<역할>.md, Task 정의, Ledger(Planner), Step 정의(Worker·Reviewer)
- Step inputs 참조 → 로컬 위치. 기준은 전체 SHA
- Planner: 직전 공식 Gate·Feedback·이전 Decision·Skill 카탈로그·남은 한도
- 재작업 Worker: 이전 HEAD·meta·노트·Gate·Feedback. 기존 commit 보존, 추가 commit
- Reviewer: 검토 대상 버전 전체와 diff 명령, 작업 노트, deterministic 결과, 이전 Gate
- 완료 조건을 바꾸거나 더한 사람 Feedback. 실행 중 지시가 없으면 '없음'
- artifact 본문 찾는 법(meta.content_key 또는 meta.code), 서술 검사의 실제 명령
- 검사 빌드 위치: Task worktree의 node_modules/.cache/devflow-test-build

출력:
- 데이터 디렉터리 밖 지정 파일. 형식은 역할 지침과 스키마를 따름
- packet_gaps 필수. Planner는 Ledger로 충분했던 것/부족해 다른 파일을 읽은 것을 구별
- Worker: task branch에 commit, push 금지. commit 직후 노트부터 쓰고 검사 결과를 덧붙임
  노트 맨 위 summary 3~5줄, '확인하지 못한 것' 필수. worker-output JSON도 별도 출력
- 재작업 Reviewer: 새 버전 전체 판정. 수정분 노트라면 앞 노트와 합친다고 명시
- 시각은 시계에서 얻고 출력 기록에는 로컬 경로를 쓰지 않음

금지:
- 지정 출력(Worker는 Workspace 포함)과 직접 만든 OS 임시 디렉터리 하나 밖에는 쓰지 않음
- 스스로 승인하지 않음. Worker·Reviewer가 다음 Step을 정하지 않음
- 새 세션·서브에이전트 금지. 실제 데이터 repo에 개발 중 task branch 쓰기 명령 실행 금지
```

패킷은 `submit-run --packet`, 역할 출력은 각 완료 명령, 검증 결과는 `record-gate --deterministic`으로 받아들인다. 따르는 지침과 수정 대상 파일이 같으면 **지침은 기준 SHA, 대상은 Workspace**라고 구별한다. 문서 하나만 읽는 실험은 읽는 순서를 적는다. 대소문자 구별 실험은 직접 만든 OS 임시 폴더에 `fsutil file setCaseSensitiveInfo <dir> enable`을 쓸 수 있다. Workspace와 의존성을 링크로 잇지 않는다.

## 메시지·실패·Ledger 기록

- 질문·방향·요구사항·답: `npm run add-feedback -- <data-dir> <task-id> --kind <question|direction|requirement|answer> --channel <review|live|plan> --text-file <text.txt> --actor human:<id>`. 필요하면 `--step`, `--artifact-ref`, `--run`, `--decision`. 실행 중 메시지는 Feedback과 `run.message_sent`를 먼저 기록한 뒤 전달한다. Reviewer 실행 중에는 개입하지 않는다.
- 실제로 끊긴 실행: git status·diff·노트 확인 → 미commit 변경을 데이터 밖 partial diff로 보존 → Workspace를 마지막 commit으로 복구 → 경위·미검증 잔여 결과를 failed notes로 → `npm run fail-run -- <data-dir> <task-id> <run> --reason <reason> --failed-notes <failed.md> --partial-diff <partial.diff>`. ended_at은 실패를 기록한 시각이다. 새 패킷에는 잔여물은 참고이며 승인·검증되지 않았다고 적는다. 버전을 만들지 못한 실행은 재작업으로 세지 않는다.
- `append-events`는 `ledger.updated`, `run.message_sent`, `decision.answered`, `task.requirement_added`만 받는다. 입력은 `{type, step_id?, run_id?, ref?, data?}` 배열이다. actor·at·system_sha·seq·task_id·commit_id를 넣지 않는다. 종료 Task에는 ledger.updated만 가능하다.

```powershell
# events.json 예: [{"type":"ledger.updated","data":{"note":"승인 요약과 후속 후보 반영"}}]
npm run append-events -- C:\git\devflow-data T-NNNN <events.json>
if ($LASTEXITCODE -ne 0) { throw 'append-events failed' }
npm run validate-data -- C:\git\devflow-data
if ($LASTEXITCODE -ne 0) { throw 'validation failed; do not commit' }
```

status는 해당 command가 엔티티·이벤트를 함께 쓴다. `validate-data`는 엔티티·이벤트·Artifact meta를 검사하고 `check-store-read`는 사본의 모든 종류·수·invalid를 대조한다. `check-gitignore`는 **첫 commit이 있고 .gitignore가 HEAD와 같은 데이터 저장소 루트**에서 사용한다. 하위 폴더·commit 없는 staged .gitignore는 T-0006의 알려진 한계다.

## Task를 끝낼 때

1. 새 Planner에게 최종 코드·최신 데이터 HEAD의 읽기 전용 사본·AC별 검사 명령을 주고 done 판단을 받는다. 새 세션을 띄우지 말라고 명시한다. `propose-step`으로 done Decision을 받아도 Task는 open이다.
2. 사람에게 AC뿐 아니라 **success_criteria 원문 한 줄마다 결과 / 남는 한계**를 보여 완료·push·merge를 확인받는다. 이미 명시적으로 받은 승인을 다시 묻지 않는다.
3. merge 뒤 main에서 typecheck·test·validate-data를 실행한다. 실패하면 완료·push를 멈추고 확인한다. 재실행했어도 첫 실패를 숨기지 않는다.
4. 통과 뒤 main에서 `npm run complete-task -- <data-dir> <task-id> --decision <done-decision> --merge-sha <full-sha> --post-merge-check <결과> --actor human:<id>`로 done을 기록한다. Ledger는 따로 갱신한다. T-0006의 기준 SHA 예외는 첫 절을 따른다.
5. 운영 도구·역할·스키마가 바뀌었으면 **merge 직후 이 문서를 고친다**(Task 밖 운영 commit). 필요하면 데이터 README도 맞춘다.
6. Task worktree·읽기 전용 checkout을 정리한다. 절대 경로가 의도한 루트 안인지, git status가 깨끗한지 먼저 확인하고 git worktree remove로 제거한다. 사용자 변경·정책 거부를 무시하거나 강제로 우회하지 않는다.
7. `retro/README.md`에 따라 회고, `roadmap.md`를 갱신한다. **Ledger 후속 후보와 회고 개선 조치를 데이터 backlog.md로 옮긴다.** 단계 전환은 회고 근거로 판단하며 Task 수나 스키마를 범위에서 제외한 사실만으로 선언하지 않는다.
8. 검증한 기록·운영 문서를 commit하고 승인된 repo를 push한다. 원격·로컬 SHA와 깨끗한 상태를 확인해 보고하고 실행 감시는 중지한다.

새 Task는 사람이 backlog에서 고르고 두 단계 Intake로 발행한다. 다음 후보 추천은 새 Task 발행 승인이 아니다.

## fake Worker 실행 시험 (ADR-0019)

실제 운영 devflow-data 대신 **별도 테스트 데이터와 임시 대상 저장소**에서 시험한다. Task 발행·Step 정의·Workspace 준비는 앞 절의 입구를 사용한다. 아래 예는 `step-001`이 defined이고 outputs가 `plan` 문서 하나이며, 다음 Run ID가 `R-001`인 경우다. 이미 Planner 등 Run을 기록했다면 다음 ID를 사용한다. fake는 코드 변경/commit을 만들지 않는다.

공유 데이터 밖에 `worker-input.yaml`을 만든다. artifacts는 해당 Step의 outputs와 정확히 맞아야 한다. code/repo 출처가 필요하면 기존 complete-run 규약대로 실제 SHA/저장소 상대 경로를 명시한다.

```yaml
prompt: '{"mode":"success","delayMs":5000,"output":"{\"summary\":\"fake Worker 완료\",\"packet_gaps\":[],\"work_notes\":\"# 시험 작업 노트\"}"}'
artifacts:
  - name: plan
    source: blob:work-notes
```

```powershell
npm run submit-worker -- C:\temp\demo-data T-0001 step-001 R-001 C:\temp\worker-input.yaml --machine-config C:\temp\machine.yaml --runner-dir C:\temp\runner-state
npm run worker-status -- C:\temp\demo-data T-0001 R-001 --runner-dir C:\temp\runner-state
npm run collect-worker -- C:\temp\demo-data T-0001 R-001 --runner-dir C:\temp\runner-state
```

submit은 완료를 기다리지 않는다. 제출한 터미널/호출자를 종료한 뒤에도 같은 머신의 다른 프로세스에서 status/collect할 수 있다. 실행 중이면 나중에 collect를 다시 호출한다. 수집 후 `collected: true`, `run.status: completed`와 Artifact를 확인한다. 같은 입력으로 submit을 재호출하거나 collect를 반복해도 Worker/Artifact/이벤트는 늘지 않는다. query/collect는 머신 Workspace 설정 없이도 실행 기록으로 회수한다. runner-dir는 모든 호출에 같은 값을 주고 공유 데이터와 Task worktree 밖에 둔다.

실패 시험은 새로 실행 가능한 Step/Run에서 prompt의 mode를 `fail` 또는 `crash`로 바꾼다. `success`의 output을 `{"summary":"packet_gaps 누락"}`으로 주면 invalid_output이다. `missing_output`은 파일 없이 exit 0으로 끝나는 경우다. `output_then_wait`는 출력 파일을 먼저 쓰고 delayMs 동안 기다려, 출력만 있고 종료 영수증은 없는 상태를 시험한다. 이미 제출한 Run의 입력을 바꾸면 거부되므로 새 ID가 필요하다. 자동 출력 재시도는 없다.

명령이 0으로 끝났다는 것은 관찰/요청이 처리되었다는 뜻이다. 실행 성공 여부는 JSON의 `execution.state`, 수집 여부는 `collected`를 본다. unknown은 자동 실패/재실행하지 않으며 응답의 reason/action과 [수동 확인 절차](design/runner.md)를 따른다. `ExecutionError`는 로컬 실행 또는 공유 기록이 남았을 수 있음을 의미한다. resume·실행 중 메시지·stream·cancel·read 격리는 지원하지 않는다.

## 실제 Worker CLI 실행 (ADR-0020)

기존 fake 입력/명령은 그대로 쓸 수 있다. 실제 backend는 `submit-worker`, `worker-status`, `collect-worker`에 같은 `--backend`를 명시한다. 입력 JSON의 backend와 일치해야 한다. CLI 설치·인증은 사람이 사전에 준비하며 devflow는 자동 설치/로그인/전역 설정 변경을 하지 않는다. OpenCode는 어댑터와 대역 계약 테스트만 완료됐으며 **실제 OpenCode 연동은 미검증**이다.

Task Workspace 준비와 Step 정의를 끝낸 뒤, Step outputs가 `report` document 하나라고 가정한 최소 입력은 다음과 같다. 입력 파일은 공유 데이터 디렉터리 밖에 둔다.

```json
{
  "backend": "claude-code",
  "model": "sonnet",
  "prompt": "현재 Task 작업공간에 hello.txt를 만들고 hello devflow와 줄바꿈 하나를 써라. commit이나 설치는 하지 마라. 작업 내용을 work_notes에 기록하고 안내된 역할 출력 JSON 파일을 써라.",
  "artifacts": [{ "name": "report", "source": "blob:work-notes" }]
}
```

```powershell
npm run submit-worker -- C:\work\test-data T-0001 step-001 R-001 C:\work\worker-input.json --backend claude-code --runner-dir C:\work\runner-state --machine-config C:\work\machine.yaml
npm run worker-status -- C:\work\test-data T-0001 R-001 --backend claude-code --runner-dir C:\work\runner-state
npm run collect-worker -- C:\work\test-data T-0001 R-001 --backend claude-code --runner-dir C:\work\runner-state
```

Codex를 선택하려면 입력 backend와 명령 옵션을 `codex`로 바꾸고, model은 설치된 CLI에서 접근 가능한 모델을 명시하거나 필드를 생략해 기본값을 쓴다. OpenCode는 `opencode`, model은 `provider/model` 형식이다. backend/model/prompt/산출물 정책은 실행 입력의 일부이므로 기존 Run에서 바꾸지 않는다. 다른 입력은 새 Run으로 제출한다. 누락한 backend는 fake로만 해석된다. stdout은 출력 JSON으로 간주하지 않으며, 프로세스 성공 종료와 유효한 출력 파일을 모두 확인한 뒤 수집한다.

코드 Artifact가 필요하면 Step의 `code_change` 출력 이름에 `"source": "workspace:code"`를 매핑한다. Worker가 실제 commit을 남겨야 하며, 시스템은 성공 종료 때 clean Task branch·기준 SHA ancestry·현재 HEAD를 검증한다. 자동 commit/reset은 없다. 미커밋 변경이나 권한 거부는 해결된 것으로 취급하지 않는다. 실제 백엔드는 미래 SHA를 지정하는 `code:<sha>..<sha>`나 `repo:` 출처를 거부한다. 문서와 코드 출력 둘을 선언했다면 두 이름을 모두 매핑한다.

호출자가 종료됐으면 원래 머신/runner-dir/backend에서 같은 입력으로 submit을 다시 호출하거나 status/collect를 실행한다. 이미 시작한 실행은 새로 만들지 않는다. 출력 파일만 있고 종료 영수증이 없거나 supervisor/로컬 기록이 유실됐으면 unknown이며, 시작 표식을 삭제하거나 새 실행으로 덮지 말고 [Runner 수동 확인 절차](design/runner.md#수동-확인)를 따른다. 실행이 정상 종료됐다면 반복 collect는 기존 Run/Artifact를 돌려주며 이벤트를 추가하지 않는다.

재현 가능한 실제 CLI 검증은 `node tests/runner/real-smoke.mjs claude-code`와 `node tests/runner/real-smoke.mjs codex`다. 각각 임시 대상 repo·Task worktree·테스트 Store에서 작은 파일과 문서 Artifact를 만들고 실행 중 caller를 강제 종료해 회수한다. 일반 `npm test`에는 모델 호출이 없다. 옵션 근거·검증 버전·제약은 [Runner 계약](design/runner.md#공통-계층과-실제-cli-어댑터)에 있다.
