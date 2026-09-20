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
| commands / queries | 사람·외부가 시스템에 접근하는 유일한 경로. 기록은 모두 command 가 Store 의 commit 으로 쓴다. 규약 `docs/design/commands.md` (아래 2.2) | in-process 함수. 0단계에는 운영 스크립트(`scripts/*.mjs`, 입구)가 조립 지점을 거쳐 부른다 | HTTP API |
| State Store | Task/Step/Decision/Feedback/GateResult/Run/Artifact 와 이벤트, blob 저장. Task 안의 ID 발급, 불변 기록의 덮어쓰기 방지, commit 식별자. 인터페이스 `src/store/types.ts`, 설계 `docs/design/store.md` (아래 2.1) | 파일 (`devflow-data` repo), `src/store/file/` | DB + object storage |
| Orchestrator | 멱등 `advance(task_id)`, 역할별 HITL | `execution` 요청 또는 `hitl` 메뉴로 호출 | 이벤트가 호출 |
| Role Runner | `prepare / submit / inspect` 비동기 실행·결과 회수 | 공통 detached supervisor + fake / Claude Code / Codex / OpenCode. 관리형 네 역할과 별도 질문 인계 | job queue + 컨테이너 |
| Workspace | Task 별 branch/worktree 준비·조회·중단 후 대조 | `src/workspace/types.ts` 뒤의 로컬 Git 구현, `prepare-workspace`·`workspace-status` | 서버 clone, remote 경유 |

### 2.1 State Store 와 스키마 로더

- **다루는 것**: kind 일곱 — `task`, `step`, `decision`, `feedback`, `gate_result`, `run`, `artifact`(Artifact 버전의 meta) — 을 `get`/`list` 와 `commit` 의 쓰기로, Task 의 이벤트 로그를 `readEvents` 와 `commit` 으로, **blob**(문서 본문, 작업 노트, 역할 출력 파일, 검증 로그 같은 내용물. Run 이나 GateResult 가 소유한다)을 `commit` 의 `Change.blobs` 와 `getBlob` 으로 다룬다. 한 commit 의 엔티티·blob·이벤트는 함께 기록되거나 아무것도 기록되지 않는다. key·scope·파일 위치는 `docs/design/store.md` 3절.
- **ID 발급**: Task ID 는 `createTask`, Task 안의 ID(Step, Decision, Feedback, GateResult, Run, Artifact 버전)는 `commit` 의 함수 형태가 받는 `CommitContext` 의 `nextId`·`nextArtifactVersion` 이 lock 을 쥔 뒤의 상태로 발급한다(ADR-0011, ADR-0015).
- **불변 기록**: Decision, GateResult, Artifact 버전, blob 은 한 번 쓰면 다시 쓸 수 없다(`AlreadyExistsError`). 승인은 Artifact 를 고치지 않고 승인 Feedback 과 `artifact.approved` 이벤트로만 나타낸다(ADR-0015).
- **commit 식별자**: Store 가 `commit`·`createTask` 호출마다 만들어 그 commit 의 모든 이벤트의 `commit_id` 에 넣는다. 결과를 알 수 없는 commit 은 commands 가 이것으로 확인한다(`docs/design/commands.md` 3절).
- **코드의 자리**: 인터페이스 `src/store/types.ts`, 오류 `src/store/errors.ts`, blob key 의 문법과 key 를 만드는 순수 함수 `blobRef` 는 `src/store/blob-ref.ts`(파일 위치를 모른다 — 호출자가 commit 전에 key 를 알아 엔티티에 담는다), Task id 의 모양(`isTaskId`), Task 안의 ID 와 artifact 참조의 문법(gate id 의 정규형, `parseArtifactRef`), 이벤트의 ref 로 받는 모양(`isEventRef`)은 `src/store/refs.ts`(마찬가지로 파일 위치를 모르고 commands 도 쓴다). 파일 구현체는 `src/store/file/` 이고 파일 이름 규칙(어느 기록·blob 이 어느 파일인가)은 `src/store/file/layout.ts` 한 곳에 있다 — 그 가운데 디렉터리·기록 파일 이름의 정규식과 Store 의 내부 파일 이름(`.locks/`, `.pending-*`, `.rollbacks` — 기록이 아니고 데이터 repo 의 `.gitignore` 가 가린다)은 빌드 없이 도는 validate-data·check-gitignore 와 함께 쓰려고 `src/store/file/names.mjs`(+ `names.d.mts`)에 둔다. 파일 위치 지식은 이 디렉터리 밖으로 나가지 않는다(AGENTS.md 2번).
- **스키마 로더**: `src/schema/registry.mjs`(+ 타입 선언 `registry.d.mts`) 하나가 `schemas/` 의 스키마를 모두 한 ajv 에 등록하고 이름으로 검증 함수를 준다. 스키마가 파일을 가로질러 `$ref` 하므로 모두 등록해야 한다. Store(`src/schema/validator.ts` 를 거쳐), commands(`src/commands/common.ts` — Store 가 검사하지 않는 역할 세션의 출력 `worker-output`·`reviewer-output` 과 쓰기 전 거부 문구), `scripts/validate-data.mjs`, 테스트가 모두 이것을 쓴다(ADR-0016). JavaScript 인 이유는 운영 스크립트가 빌드 없이 Node 로 돌기 때문이다.
- **빌드 출력으로 복사하는 조건**: tsc 는 `.mjs` 를 출력 디렉터리로 옮기지 않는다. 그래서 `src/` 를 tsc 로 빌드해 실행하는 곳은 빌드 뒤에 `src/**/*.mjs` 를 같은 상대 위치로 복사해야 하고, 빌드 출력은 repo 안(지금은 `node_modules/.cache/` 아래)에 두어야 한다 — `registry.mjs` 가 자기 위치에서 위로 올라가며 `schemas/` 를 찾고, 빌드물이 repo 의 의존성을 찾아야 하기 때문이다. 지금 그렇게 빌드하는 곳은 `tests/global-setup.ts`(다중 프로세스 테스트의 자식 프로세스용), `scripts/check-store-read.mjs`, 입구의 빌드 캐시 `scripts/lib/build.mjs`(`docs/design/commands.md` 6.5) 셋이고 같은 빌드·복사 코드를 따로 가진다. 배포용 빌드나 다른 출력 디렉터리를 만들 때 같은 처리가 필요하다.
- **검증용 스크립트**: `scripts/validate-data.mjs` 는 데이터 디렉터리의 기록을 스키마로 검사한다(Store 를 쓰지 않고 파일을 직접 읽으며, 어느 디렉터리·파일을 읽을지는 Store 와 같은 이름 규칙 모듈 `src/store/file/names.mjs` 를 import 해 정한다). `scripts/check-store-read.mjs`(`npm run check-store-read -- <data-dir>`)는 데이터 디렉터리를 Store 의 파일 구현체로 열어 모든 kind 와 blob 이 읽히는지 확인한다 — 파일 구현체를 빌드 출력에서 직접 import 한다. `scripts/check-gitignore.mjs`(`npm run check-gitignore -- <data-dir>`)는 데이터 repo 의 checkout 에서 `git check-ignore` 로 내부 파일의 예시 경로(`names.mjs` 의 `internalPathExamples`)가 모두 무시되는지 본다 — 경로마다 마지막으로 맞은 규칙이 부정 규칙(`!`)이 아니고 그 checkout 이 추적하는 `.gitignore`(HEAD 와 같은 내용)의 것이어야 하며, `core.excludesFile`·`.git/info/exclude` 의 규칙은 데이터 repo 의 보장으로 받지 않는다. 셋 다 시스템을 검증하는 개발용 스크립트이지 사람이 시스템에 접근하는 CLI/UI 가 아니므로 AGENTS.md 1번(CLI 는 commands/queries 만 호출)의 대상이 아니다. 데이터를 쓰지 않는다.

### 2.2 commands 와 0단계의 입구

- **기록 command**(`src/commands/`, 목록은 `index.ts`): Task 발행 `createTask`·done `completeTask`, Step 한 바퀴 `submitRun`·`completeRun`·`failRun`·`recordGate`·`recordDecision`·`defineStep`·`requestRevision`·`approveStep`·`addFeedback`, 짝이 되는 엔티티가 없는 이벤트 `appendEvents`. 첫 인자는 `CommandContext`(Store, 시계, actor, system_sha, 선택적 기본 branch resolver). 기록 command 하나는 한 commit이고 시각·ID·status·commit_id는 도구가 채운다. `createTask`는 원격 기본 branch 조회 후 한 commit으로 발행한다. Step 기록 command는 `common.ts`의 `commitAfterReading`으로 충돌 시 다시 읽고 판단한다. `appendEvents`는 같은 원칙의 자체 루프를 쓴다. 별도 **실행 command `prepareWorkspace`는 두 commit 사이에 Git 작업이 있는 예외**다(아래 2.3, ADR-0018). `submitWorker`도 로컬 prepare→공유 submitRun→Runner 시작을 연결하는 다단계 command다(8절, ADR-0019). 입력·거부 조건은 `docs/design/commands.md`.
- **Step status 의 전이표**는 `src/commands/transitions.ts` 한 곳에 있고 status 를 바꾸는 command 는 모두 그것으로 판단한다(표는 `docs/design/commands.md` 7절). **이벤트의 ref** 는 `src/store/refs.ts` 의 `isEventRef` 가 받는 모양만 기록된다.
- **입구**(`scripts/*.mjs` — `issue-task`, `submit-run`, `propose-step`, `define-step`, `complete-run`, `fail-run`, `record-gate`, `request-revision`, `approve-step`, `add-feedback`, `complete-task`, `append-events`)는 인자와 입력 파일을 읽어 command 하나를 부른다. command 와 Context 는 **조립 지점** `scripts/lib/assemble.mjs` 가 만든다 — scripts/ 에서 Store 의 파일 구현체를 여는 곳은 여기(와 검증용 check-store-read)뿐이다. 입구는 그것과 인자 해석·파일 읽기·보고의 공용 모듈 `scripts/lib/cli.mjs`, `node:` 모듈만 import 한다(`tests/architecture.test.ts`). 조립 지점은 `src/` 를 `tsc --noCheck` 로 빌드해 쓰고, 소스의 내용 해시가 같으면 빌드를 다시 쓴다(`scripts/lib/build.mjs`, `docs/design/commands.md` 6.5).
- 역할 세션의 출력(worker-output, reviewer-output, Planner 의 Decision, deterministic 결과)과 사람이 쓴 정의(Task, 고친 Step)는 데이터 디렉터리 밖의 파일로 받아 command 가 blob·엔티티로 쓴다. 입구가 받은 로컬 경로는 기록되지 않는다. 사람이 한 일의 입구는 `--actor human:<id>` 를 요구하고, 승인은 사람이 본 Gate(`--gate G-NNN`)의 버전만 승인한다.
- Ledger(`ledger.md`)는 command 가 쓰지 않는다 — 편집 도구로 쓰고 그 사실을 `ledger.updated` 로 `append-events` 가 남긴다.

### 2.3 Workspace 준비 (구현됨)

- 공개 경로는 `commands.prepareWorkspace(ctx, { taskId })`, `queries.getWorkspace(ctx, taskId)`다. 확장 Context가 Store와 `Workspace` 인터페이스를 받는다. `src/workspace/git/`만 Git 명령·로컬 경로·머신 관리 기록을 안다. 조립 지점이 `GitWorkspace`와 `FileProjectCatalog`를 만든다. 준비된 위치를 역할 실행과 `advance`의 Verifier가 사용한다. 질문용 `Workspace.snapshot`은 worktree 파일이 아닌 고정 SHA의 Git 객체를 읽는다.
- 발행 입력에 branch가 없으면 등록 원격의 HEAD를 조회한다. 이름만 지정하면 remote, local은 이름 필수다. 최초 준비는 remote branch를 fetch하거나 local branch를 읽어 SHA를 고정한다. 실패 시 다른 출처로 대체하지 않는다. 옛 Task의 출처는 추정하지 않는다.
- 준비는 `workspace.prepare_requested` commit → Git 생성/대조 → `workspace.prepared` commit이다. 두 commit은 원자적이지 않다. 재호출은 고정 SHA와 로컬 소유 기록·Git 상태·생성 완료 표식을 대조한다. 정상 작업공간이 있으면 변경을 보존하고 빠진 완료 기록만 보충한다. 완료된 작업공간이 없어졌거나 소유/branch/저장소가 다르면 중단한다.
- Git common directory의 `devflow-workspaces/`는 머신별 소유 기록과 완료 표식·잠금을 보관한다. 공유 State Store 밖의 실행 구현이며 Task 이벤트에는 위치를 기록하지 않는다. 원격 fetch는 고유 `refs/devflow/fetch/`에 받아 최초 SHA를 보존한다. 자동 정리는 이번 범위 밖이다.
- 겹친 Git 준비는 기다리지 않고 거부한다. Git 생성 도중 강제 종료로 잠금이나 부분 checkout이 남으면 수동 확인을 요구한다. 자동 잠금 회수·삭제·reset은 없다. 의도 기록 뒤 또는 정상 Git 완료 뒤의 중단은 같은 명령으로 복구한다.
- 운영 입구는 `prepare-workspace`와 `workspace-status`. 머신 설정은 `--machine-config` 또는 `DEVFLOW_MACHINE_CONFIG`, 프로젝트 등록부는 데이터 루트의 `projects.yaml`이다. 포맷은 `schemas/project-registry.schema.json`, `schemas/workspace-machine-config.schema.json`이 기준이다. 사용 예는 `docs/stage0-manual-operation.md`.

### 2.4 발행 전 Intake

같은 Store가 선택적 `IntakeRepository`를 제공한다. FileStore의 `src/store/file/intake.ts` 구현은 기존 lock/파일 연산 아래에서 revision별 불변 스냅샷에 사건·상태·입출력을 함께 게시한다. Task의 필수 필드나 기존 Run의 Task 소속을 느슨하게 만들지 않는다. 새 기록의 기준은 `schemas/intake-draft.schema.json`과 `intake-output.schema.json`이다.

`createIntake / submitIntake / collectIntake / confirmIntakeIntent / publishIntake`는 의도 확인 → 정의 확인의 두 사람 확인 지점을 연결한다. Runner가 준비한 별도 빈 cwd에서 실행하며 대상 repo의 worktree가 아니다. 확인된 의도를 정의 출력이 바꾸면 거부한다. 발행 중 중단은 생성 이벤트의 초안 버전 출처로 기존 Task를 회수하며, 결과가 불명확하면 자동 재발행하지 않는다. `cancelIntake`는 종료 요청 후 수집 경로를 유지한다.

## 3. 엔티티

```
Task 1 ─── N Step 1 ─── N Run ─── Artifact(version)
                │                         ▲
                │                     Feedback (특정 version 에 부착)
                ├── GateResult (특정 Artifact version 에 대한 판정)
                └── Decision   (Planner 출력: 다음 행동 + 근거)
```

필드 정의는 `schemas/` 가 기준이다.

- **Task** — 사람이 쓴 정의를 `createTask` 가 발행한다(id·status·created_at·created_by·task_branch 는 도구가 채운다). 유형, 대상 repo, 목표(바라는 결과), 배경, 제약, 수용 기준(AC) + 의도의 칸: 문제, 식별 가능한 성공 기준, 영향받는 사람과 시스템, 범위 밖, 열린 질문(질문마다 누가 답하는가). AC 는 성공 기준을 검증 가능한 문장으로 옮긴 것이고 각 AC 가 어느 성공 기준을 옮겼는지 가리킨다. 사람이 답해야 할 열린 질문이 남은 Task 는 스키마가 거부해 발행되지 않는다 (ADR-0013)
- **Step** — goal / scope / inputs / outputs / done_when / verify / approval
- **Artifact** — 문서는 `artifact://T/step/name@vN`, 코드는 `repo+branch+SHA`. 버전마다 한 번 쓰면 바뀌지 않는 meta 가 있고 내용이 어디 있는지(Store 의 blob 인지 대상 repo 인지)를 말한다. 승인된 버전이 공식 기록이고, 승인은 그 버전을 가리키는 승인 Feedback 과 이벤트로 나타낸다
- **Run** — 역할 세션 한 번의 실행 기록(backend, model, 수행 주체, packet_gaps). Step 에 속하거나(Worker, Reviewer) Task 에 속한다(Planner). 발행 전 Intake 실행은 별도 초안 기록에 속한다. 출력 파일·작업 노트·transcript 는 그 Run 이 소유한 blob 이다
- **ID** — Task 는 `T-NNNN`, Task 안에서 Step `step-NNN`, Decision `D-NNN`, Feedback `F-NNN`, GateResult `G-NNN`, Run `R-NNN`, Artifact 버전 `v<N>`. 모두 Store 가 발급하고 Task 안에서 kind 마다 유일하다
- **Feedback** — 수정 요청 / 질문 / 승인 / 요구사항 추가. 검토 시 또는 실행 중(live) 발생
- **GateResult** — pass/fail, 항목별 결과, 근거, Reviewer 의 지적(severity · class A/B/C · text). Reviewer 가 아닌 출처(시스템, Worker 의 실측)의 정보는 `annotations` 에 따로 담는다
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

- `checking`: Worker 결과 직후에는 설정된 Worker HITL을 먼저 기다린다. 승인은 검증 시작만 허용한다. 그 뒤 Step의 `verify`에 선언된 deterministic → semantic 검증만 수행한다.
- Reviewer 결과를 기록해도 설정된 Reviewer HITL을 수용하기 전에는 checking을 유지한다. pass 수용은 in_review, fail 수용은 revising이다. 같은 버전의 재검토도 새 Gate로 남긴다.
- 최종 Artifact 승인은 검증한 버전의 pass Gate를 지목한다. `approval: optional`이고 deterministic이 있을 때만 자동으로 approved→closed를 통과한다. deterministic이 없으면 항상 사람이 최종 승인한다.
- 역할별 HITL은 기본적으로 모두 켜져 있으며 `workflow-start.config.hitl`에서 각각 생략할 수 있다. Planner 수정은 과거 Decision을 보존하고 기존 proposed Step을 cancelled로 전이한 뒤 새 제안을 만든다.

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

`advance` 한 호출의 진행 횟수는 제한되어 있으며 비동기 실행/HITL에서 반환한다. Task 전체의 재작업·비용 상한 정책은 아직 없다.
`done` 결정은 AC 별 충족 근거가 필수이고 사람이 최종 확정한다.

## 6. Step 과 Skill

- Step 스키마는 하나다. **Freeform** 은 Planner 가 모든 필드를 작성하고, **Skill** 은 파라미터가 있는 Step 템플릿 + Worker 지침 + 기본 검증이다.
- 자동 흐름은 완전한 Step 정의를 받는다. Skill 이름/파라미터만인 제안의 자동 펼치기는 미구현이므로 수용 후 정지하고 전체 정의로 재제안할 수 있다.
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

`scripts/hitl.mjs`는 **승인 / 수정 요청**과 보조 선택 **질문 CLI 열기**를 제공한다. JSON/YAML 입구 `scripts/execution.mjs`도 같은 commands/queries를 호출한다. 상세 사용법은 [역할 실행 사용법](execution-usage.md), 결정은 [ADR-0022](adr/0022-role-hitl-and-independent-questions.md)를 따른다.

| 접점 | 방식 |
|---|---|
| Task 발행 | `execution`의 Intake 의도 확인 → 정의 확인 → 발행 |
| 진행 | `workflow-start`, `advance`; 실행 중에는 반환하며 새로고침 때 수집 |
| 검토 | `hitl` 메뉴 또는 `respond`; 정확한 대기 대상과 버전으로 승인/수정 요청 |
| Planner의 추가 판단 필요 | ask_human/rework/abort/Skill 제안 수용 뒤 정지; 설명을 보고 새 계획 수정 요청 가능 |
| 관찰 | `status`, `log`, `hitl` 조회 |
| 실행 중 개입 | 지원 backend의 `message` — **이벤트 기록 후** 관리형 세션에 전달 |
| 독립 질문 | `question` — 새 읽기 전용 CLI에 고정 자료를 넘기고 즉시 복귀 |

- 수정 요청은 Step 산출물에, 요구사항 추가는 Task 에 붙는다.
- 관리형 흐름의 수정은 새 역할 Run과 새 Artifact/Gate/Decision으로 기록된다. 사용자 worktree 변경이 기록된 코드 버전과 어긋나면 재작업/검증을 거부하며 자동 reset하지 않는다.
- 질문 대화/종료는 승인이나 수정 요청이 아니다. 최종 산출물 승인은 Gate를 거친 특정 버전으로만 한다.
- Worker 는 Step 종료 시 "실행 중 받은 지시 요약" 을 출력한다. 사람은 검토 시 그중 Task 요구사항으로 올릴 것을 확인한다.
- Reviewer 세션에는 개입하지 않는다(검증 독립성). 판정에 이견이 있으면 결과에 피드백을 남긴다.

## 8. Runner 와 역할 실행

구현: TypeScript + Node.js LTS. Runner 인터페이스는 `src/runner/types.ts`, 공통 로컬 관리는 `src/runner/local/`, 백엔드 어댑터는 `fake/`, `claude-code/`, `codex/`, `opencode/`다. 계약은 [Runner](design/runner.md), 운영 예는 [역할 실행 사용법](execution-usage.md), 결정은 ADR-0019·0020·0021을 따른다.

- 기존 `submitWorker / getWorkerExecution / collectWorker`를 유지하고, Planner·Reviewer의 `submitRole / getExecution / collectExecution`을 추가했다. `cancelExecution / sendExecutionMessage / getExecutionLog`가 실행 제어·관찰을 담당한다. 공통 운영 입구는 `scripts/execution.mjs`다. CLI는 commands/queries만 호출한다.
- 조립 지점은 Store 하나와 Workspace, 실행 설정 제공자, RunnerRegistry를 Context에 주입한다. Registry는 backend별 어댑터를 재사용하며, 재조회에는 저장된 Run의 backend를 선택한다. 명시적 backend가 기록과 다르면 오류다.
- 네 역할의 설정은 `src/settings/`에서 해석한다. 전역/프로젝트 defaults·역할·작업 유형 → 확정 Step → 명시 실행 입력의 순서다. backend가 바뀌면 상속 model/reasoning을 지운다. 파일 위치/포맷은 파일 설정 제공자만 안다. 실효값·출처와 해석 전후 digest를 제출 시 고정하고 재제출 때 설정을 다시 읽지 않는다.
- 새 제출은 로컬 prepare → 공유 submitRun → Runner 시작이다. 영구 launch claim 뒤에는 자동 재시작하지 않는다. supervisor는 호출자가 종료되어도 실행하고 종료 영수증을 게시한다. 실행 UUID를 확인하는 loopback 응답만 running 증거로 삼는다. 근거가 없으면 unknown이며 출력/PID만으로 결과를 추측하지 않는다.
- Worker는 Task worktree의 write 실행이다. Planner·Reviewer는 같은 Task worktree의 read 실행이다. Task 안에 수집 전인 관리형 실행이 있으면 다른 역할을 시작하지 않는다. Reviewer는 특정 Artifact 버전들을 입력으로 받는다. read 실행은 ignored를 포함한 파일 내용과 HEAD·index를 시작/종료에 대조하고, 위반 시 변경을 보존하며 invalidated로 기록한다. symlink/junction workspace는 이 검증에서 거부한다.
- 출력은 역할별 JSON 파일과 스키마로 받는다. Worker는 completeRun, Planner는 recordDecision, Reviewer는 recordGate의 기존 원자적 기록 경로에 연결한다. 코드 산출물은 Git 구현이 clean Task branch·기준 commit ancestry·종료 HEAD를 확인한 SHA를 쓴다. Store 오류를 역할 실패로 바꾸지 않는다.
- Worker 재작업과 읽기 역할에 최소 Context를 고정해 제공한다. Task/Step, Artifact, Gate, Feedback과 Worker의 이전 노트를 포함한다. 참조 전체의 자동 해석·Ledger 조립·실효 요구사항 합성은 R03·R04의 후속이다. 로컬 실행 계획에는 역할 지침과 프로젝트 AGENTS.md도 고정된다.
- supervisor가 timeout과 취소 요청을 관찰하고, 해당 실행의 프로세스 트리 종료 뒤에만 결과를 게시한다. 사람 메시지는 Store 이벤트가 성립한 뒤 전달하며 ID로 중복을 막는다. Claude Code의 stream input을 지원하고, Codex/OpenCode의 live 입력과 Reviewer 개입은 거부한다. 백엔드 메시지/로그 형식은 어댑터의 protocol 모듈에만 있다.
- 로그는 실행 ID에 연결한 머신별 진단 자료다. stdout/stderr/통합·정규화 로그를 각각 최대 8 MiB 보관하며 자동 삭제하거나 공유 Store로 복사하지 않는다. 출력 재시도는 기본 0이다. 설정한 재시도도 종료가 확인된 출력 위반에만 적용한다.
- 사용자 결정에 따라 모든 역할은 신규 세션이고 resume는 미지원이다. backend session ID는 진단 연결을 위해 수집한다. 완료 Run은 수집 영수증이므로 다시 수집해도 Artifact/Gate/Decision을 추가하지 않는다.
- `startWorkflow / advance / respondHitl / getWorkflow`가 역할별 수용과 재작업을 연결한다. Task의 진행 커서와 action 예약·HITL 응답은 사건과 같은 CAS commit에 기록한다. 역할 결과 수집 후 커서 갱신 전에 중단되면 완료 Run에서 복구한다. 자동 흐름이 시작된 Task에서는 개별 시작/기록 전용 전이로 HITL을 우회하지 못한다.
- `src/verification/types.ts` 뒤의 로컬 Verifier는 Task worktree에서 선언된 시스템 명령을 비동기 실행한다. 준비 → 영구 시작 표식 → supervisor 영수증을 사용하며 unknown을 자동 재실행하지 않는다. `.devflow.yaml`의 `@명령`과 timeout을 지원한다. setup/exclusive 조율은 지원하지 않으며 선언된 경우 명시적으로 거부한다.
- `Runner.openQuestion`은 관리형 실행과 별도다. 고정 문서/Git 자료를 독립 디렉터리에 제공하고 Windows 콘솔로 인계한 즉시 반환한다. 질문 Run·잠금·종료 감시·답변 수집은 없다. Codex 0.154.0·Claude Code 2.1.278·OpenCode 1.x 질문 어댑터를 제공한다(ADR-0024). 공통 자료 준비/콘솔 인계는 `runner/local/question`, 각 CLI의 권한·옵션은 개별 어댑터가 담당한다. Codex는 read-only sandbox, Claude는 restricted와 읽기 도구만 허용, OpenCode는 문서 기반 전용 agent 권한을 적용한다. 인증 파일은 복사하지 않아 native 창에서 인증/초기 설정이 필요할 수 있다. 초기 질문·대상·인계 시도/결과만 이벤트로 남긴다.
- 질문의 backend/model/reasoning은 `roles.question`으로 기존 전역·프로젝트·작업 유형·확정 Step·명시 입력 계층에서 선택한다(ADR-0023). 대상 Run의 AI 설정을 상속하지 않는다. 실효값/출처는 초기 질문 사건에 고정한다. 공통 defaults의 관리형 실행 옵션은 질문에서 제외하고 질문 전용 설정에는 허용하지 않는다. question은 설정 선택자이며 새로운 관리형 Run 역할이 아니다.
- 관리형 read 사후검사는 완전한 OS 격리가 아니다. 질문은 Codex sandbox 표본 쓰기 차단, Claude 옵션/대역 계약을 검사한다. OpenCode는 사용자 요청에 따라 공식 문서로만 구현하며 실행·권한 동작은 검사하지 않는다. 실제 모델 질문 대화도 미검증이다.

## 9. 여러 프로젝트와 동시 진행

- 상태는 Task 단위로 분리되어 있고 `advance(task_id)` 는 Task 별로 멱등이다. 여러 Task 를 동시에 진행할 수 있다.
- **Task 하나 = repo 하나 = worktree 하나.** Worker 와 Gate 는 그 Task 의 worktree 안에서만 실행한다. worktree 경로는 Workspace 관리자가 실행 시점에 풀어 주며 기록하지 않는다. 여러 repo 에 걸친 작업은 Task 를 나눠 발행한다.
- 프로젝트 이름 → remote URL은 `devflow-data/projects.yaml`에, 로컬 clone·worktree 루트·remote 이름은 머신별 설정에 둔다. 등록부의 옛 기본 branch 값은 호환용으로 읽지만 새 Task의 기본값은 원격 HEAD에서 조회한다(ADR-0018).
- Step 의 `inputs` 는 `code://<project>@<sha>` 로 대상 repo 가 아닌 등록된 프로젝트도 가리킬 수 있다. 그 참조는 읽기 전용이고, 쓰기가 가능한 Workspace 는 대상 repo 의 task branch 하나뿐이다. 참조 문법은 `schemas/step.schema.json` 이 강제한다.
- 대상 repo의 `.devflow.yaml`이 검증 명령을 정의한다. `exclusive: true`의 프로젝트 간 Gate 잠금은 미구현이며 현재 Verifier는 해당 설정을 거부한다.
- Store 파일 구현체는 같은 Task 에 대한 commit 을 Task 별 lock 으로 직렬화한다. Task ID 는 lock 없이 `mkdir` 의 원자성으로 발급하고(ADR-0011), Task 안의 ID 는 그 Task 의 lock 안에서 발급하므로 동시 commit 에서도 겹치지 않는다(ADR-0015). `devflow-data` 의 git 자동 commit 은 직렬화해야 한다(미구현).
- 같은 repo의 서로 다른 Task는 별도 worktree에서 진행한다. base branch 이동 감지·교차 Task 대기 화면·전역 동시 실행 수 상한은 후속 범위다.

## 10. 저장 위치

| 종류 | 위치 |
|---|---|
| 설계 문서, 스키마, 역할 프롬프트, Skill, 코드 | 이 repo (`devflow`) — 서버화 이후에도 git 에 유지 |
| Task 실행 데이터 | `devflow-data` repo — Step 전이마다 자동 commit. 서버화 시 DB 로 이전 |
| 코드 산출물 | 대상 repo 의 task branch. 대상 repo 에는 `.devflow.yaml` 만 추가 |

Task 이벤트에는 실행 당시 `devflow` repo 의 commit SHA 를 기록한다(어떤 버전의 프롬프트/스키마로 실행되었는지 추적).
