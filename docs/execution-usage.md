# 역할 실행 사용법

기본 흐름은 **새 실행 → 상태 확인 → 결과 수집**이다. 설정을 바꿔도 이미 제출한 실행은 제출 당시 설정을 유지한다. 모든 역할은 새 세션을 사용한다.

## 설정

전역 설정 파일의 예:

```yaml
roles:
  worker:
    backend: codex
    model: gpt-5.5
    reasoning: high
  reviewer:
    backend: claude-code
    model: sonnet
    reasoning: high
  planner:
    backend: codex
  intake:
    backend: claude-code
  question:
    backend: codex
    model: gpt-5.5
    reasoning: medium
```

모델 이름은 사용 계정·CLI가 지원하는 값으로 지정한다. backend별 추론 옵션은 의미와 지원 범위가 다르며 미지원 값은 거부한다. 관리형 OpenCode의 추론 옵션은 미지원이다. 독립 질문의 OpenCode reasoning 지원 범위는 아래 표를 따른다. 설정을 생략한 기존 관리형 역할의 fake 사용법도 유지한다. 독립 질문의 제품 기본 backend는 codex이며 질문 대상 역할의 모델을 자동 재사용하지 않는다.

프로젝트의 `.devflow.yaml`에서는 같은 내용을 `execution:` 아래에 둔다. 전역보다 프로젝트 설정, 프로젝트보다 확정된 Step 설정, 그보다 이번 실행의 명시 입력이 우선한다. 작업 유형별 설정은 `task_types.<유형>.<역할>`에 둔다. 설정 필드의 정확한 계약은 schemas의 description을 따른다.

## 공통 운영 입구

```powershell
npm run execution -- <data-dir> <request.json> --runner-dir <runner-dir> --config <global.yaml> --machine-config <machine.yaml>
```

`--config` 대신 `DEVFLOW_CONFIG`를 사용할 수 있다. `--project-config`는 프로젝트 설정 파일을 명시할 때 사용한다. 사람의 확인·취소·메시지에는 `--actor human:<이름>`을 추가한다. 입력 JSON/YAML 파일은 데이터 디렉터리 밖에 둔다.

Worker 실행 요청 예:

```json
{
  "action": "start",
  "taskId": "T-0001",
  "stepId": "step-001",
  "runId": "R-001",
  "role": "worker",
  "input": {
    "prompt": "확정된 Step을 수행하고 작업 노트를 남겨라.",
    "artifacts": [{ "name": "change", "source": "workspace:code" }]
  }
}
```

Task와 Step은 기존 발행·확정 명령으로 준비한다. 산출물 이름은 Step에 선언한 이름과 일치해야 한다. Planner는 `role: planner`로 지정하고 stepId 없이 제출한다. Reviewer는 `role: reviewer`, stepId, `input.artifact_refs`에 검토할 버전 참조 목록을 지정한다.

Reviewer가 코드 Artifact를 검토하려면 작업 폴더가 그 버전의 깨끗한 HEAD·branch와 일치해야 한다. 문서 Artifact의 내용과 작업 노트는 패킷으로 전달한다. read 역할은 ignored 파일도 바꿀 수 없고 symlink/junction이 있는 작업 폴더에서는 시작을 거부한다.

같은 실행의 상태 확인과 수집:

```json
{"action":"status","taskId":"T-0001","runId":"R-001"}
```

```json
{"action":"collect","taskId":"T-0001","runId":"R-001"}
```

`collected: false`이면 프로세스 관찰 결과이고 `true`이면 공유 기록에 결과를 반영했다. 같은 collect를 반복해도 새 Artifact나 Gate를 추가하지 않는다. `unknown`이면 원래 머신·runner-dir와 실행을 확인해야 한다. 시작 표식을 지워 재실행하지 않는다.

추가 동작:

| action | 목적 |
|---|---|
| settings | role과 선택적 taskId/stepId에 적용할 값과 출처 확인 |
| cancel | 해당 실행의 종료 요청. 이후 status/collect로 실제 종료 확인 |
| log | offset부터 로그 일부 조회. nextOffset으로 이어서 조회 |
| message | text 전달. 응답의 messageId를 재사용해 전달 상태 조회 |

live message는 Claude Code에서만 지원한다. Reviewer에는 전달할 수 없다. Codex/OpenCode는 결과를 확인한 뒤 후속 실행을 준비한다. 로그 조회는 대화형 CLI 접속이 아니다.

기존 `submit-worker`, `worker-status`, `collect-worker`도 유지한다. 조회·수집 시 backend를 생략하면 기록된 backend를 사용하며, 명시한 backend가 기록과 다르면 거부한다.

## Intake

1. `{"action":"intake-create","text":"하려는 작업 설명"}`으로 초안을 만들고 반환된 id를 사용한다.
2. `{"action":"intake-start","id":"I-...","input":{"prompt":"의도 초안을 작성해줘"}}`로 실행한다.
3. `intake-status`와 `intake-collect`로 결과를 확인한다. 수정 의견은 다음 `intake-start`의 prompt에 적는다.
4. `{"action":"intake-confirm","id":"I-...","version":3}`처럼 실제로 본 revision을 지정해 의도를 확인한다.
5. 다시 `intake-start`로 정의를 만들고 수집한다. 확인한 의도를 바꾸는 정의는 거부한다.
6. `intake-publish`에 검토한 정의의 revision을 지정하면 Task를 발행한다. 같은 버전으로 반복 발행해도 Task를 추가하지 않는다.

활성 Intake는 `intake-cancel`로 종료를 요청할 수 있다. 다음 실행에 이전 질문·출력·확인된 의도가 전달되므로 resume가 필요하지 않다. Intake의 별도 cwd에는 대상 repo가 없으므로 필요한 코드 자료는 입력에 제공한다.

확인한 의도 자체를 바꾸려면 새 Intake 초안을 만든다. 정의의 발행이 입력 오류로 거부되면 같은 초안에서 정의를 수정할 수 있다. 발행 도중 중단되어 Task 생성 여부를 확인할 수 없으면 `publishing` 상태를 유지하고 기존 시도를 먼저 확인한다.

## 결과 검토와 수정

수집한 결과는 기존 승인·Feedback·재작업 명령으로 처리한다. 이미 기록한 버전을 직접 바꾸지 않는다. Worker 재작업에는 이전 작업 노트, Artifact, Gate와 Feedback이 포함된다. 수정 후에는 새 Artifact 버전과 Step에 선언된 검증이 필요하다. semantic 검증을 사용하는 경우 Reviewer도 새 세션으로 실행한다.

여기서 **검증**은 시스템의 테스트 실행(deterministic)과 Reviewer의 요구사항·범위 확인(semantic)을 뜻한다. 아래 자동 흐름에서는 역할별 HITL과 선언된 검증을 시스템이 연결한다. 자동 흐름을 시작한 Task에서는 기존 기록 전용 승인/수정 명령으로 HITL을 우회할 수 없다.

## 역할별 HITL 흐름 시작

Task 발행과 `prepare-workspace`를 마친 뒤, 열린 Step이 없거나 defined Step 하나인 상태에서 다음 요청을 실행한다. 실행 backend는 기존 전역/프로젝트/Step 설정을 사용한다. 제품 기본 fake는 테스트용이므로 실제 작업에서는 backend를 설정한다.

```json
{
  "action": "workflow-start",
  "taskId": "T-0001",
  "config": {
    "hitl": { "planner": true, "worker": true, "reviewer": true },
    "planner": { "backend": "codex", "prompt": "Task와 이전 기록에 근거해 다음 Step 전체 정의를 제안해줘." },
    "worker": { "backend": "codex", "prompt": "확정 Step과 수정 요청을 수행하고 문서 원문과 판단 근거를 work_notes에 남겨줘. 코드 변경은 commit해줘." },
    "reviewer": { "backend": "codex", "prompt": "고정된 버전의 semantic 질문과 done_when을 검토해줘. 실패 항목은 pass로 바꾸지 마." }
  }
}
```

```powershell
npm run execution -- <data-dir> <start.json> --runner-dir <runner-dir> --machine-config <machine.yaml> --actor human:<이름>
npm run hitl -- <data-dir> T-0001 --runner-dir <runner-dir> --machine-config <machine.yaml> --actor human:<이름> --question-backend codex
```

HITL 메뉴의 기본 선택은 **1 승인 / 2 수정 요청**, 보조 선택은 **3 질문 CLI 열기**다. 실행 중에는 Enter로 진행 상태를 다시 확인한다. 시작 직후 devflow를 종료해도 역할/검증 실행은 유지되며 같은 Task로 다시 메뉴를 열 수 있다. `runner-dir`는 Store와 Task worktree 밖에 둔다.

- Planner 승인: 제안된 Step을 확정하고 Worker를 시작한다. 수정 요청: 과거 Decision을 보존하고 새 Planner에서 재제안한다.
- Worker 승인: 선언된 검증을 시작한다. 최종 산출물 승인이 아니다. 수정 요청: 같은 worktree에서 새 Worker가 새 버전을 만들고 Worker HITL로 돌아온다.
- Reviewer 승인: pass/fail 판정을 그대로 수용한다. fail이면 Worker 재작업이며 다음 결과는 활성화된 Worker HITL로 돌아온다. 수정 요청은 코드·산출물 수정(Worker)과 판단 재검토(Reviewer)를 선택한다.
- 검증 pass 뒤 Step의 최종 승인이 required이면 별도 버전 승인을 기다린다. deterministic이 없으면 optional 설정이어도 사람 승인을 요구한다. 최종 승인 뒤 다음 Planner로 이어진다.

문서/data 산출물은 현재 최소 자동 흐름에서 `work_notes` 원문으로 버전 저장한다. 여러 문서 출력은 같은 노트에 들어가므로 문서를 별도 파일로 수집하는 정책은 후속이다. 코드 출력은 실행 종료 시 확인한 commit으로 저장한다. deterministic의 직접 명령과 `.devflow.yaml`의 `@명령`을 지원하며, 자동 setup/exclusive 잠금은 지원하지 않아 해당 설정은 오류로 알려준다.

## JSON 입구와 정확한 대상

```json
{"action":"advance","taskId":"T-0001"}
```

```json
{"action":"hitl","taskId":"T-0001"}
```

반환된 `target` 객체를 **그대로** 다음 요청에 넣는다. 아래 예의 UUID/ID/버전은 실제 조회값으로 바꾼다.

```json
{
  "action": "respond", "taskId": "T-0001", "response": "revise",
  "target": { "id": "00000000-0000-4000-8000-000000000001", "role": "reviewer", "run_id": "R-003", "step_id": "step-001", "gate_id": "G-001", "artifact_refs": ["artifact://T-0001/step-001/report@v1"] },
  "text": "두 번째 근거를 다시 검토해줘.", "destination": "reviewer"
}
```

승인은 `response: "approve"`, 수정은 `response: "revise"`와 text다. destination은 Reviewer 수정에서만 필요하다. 같은 응답 재전송은 기록된 영수증 조회이며, 다음 단계 진행 뒤 과거 응답을 바꿀 수 없다.

## 질문 CLI

메뉴에서 초기 질문을 입력하거나 `action: "question"`, 현재 target, text와 선택적 backend/model/reasoning을 전달한다. Windows에서 `codex`, `claude-code`, `opencode`를 선택한다. Codex는 0.154.0, Claude Code는 2.1.278을 대상으로 하며 다른 버전은 거부한다. OpenCode 1.x는 공식 가이드 기반 구현이며 **설치·실행 검증을 하지 않았다**. 다른 OS의 터미널 인계는 미지원이다.

질문 AI도 위 전역 설정의 `roles.question`을 사용한다. 프로젝트 `.devflow.yaml`에서는 다음처럼 지정한다.

```yaml
execution:
  roles:
    question:
      backend: codex
      model: gpt-5.5
      reasoning: medium
```

backend를 바꾸려면 같은 위치의 question 설정을 다음 중 하나로 지정한다.

| backend | model 예 | reasoning | 구현/검증 범위 |
| --- | --- | --- | --- |
| codex | gpt-5.5 | medium | 기존 sandbox/콘솔 smoke |
| claude-code | sonnet | high | 대화형 옵션 확인·읽기 도구/인계 대역 계약 |
| opencode | openai/gpt-5 | high | 공식 1.x 가이드 기반, 실행 미검증 |
| opencode | anthropic/claude-sonnet-4-5 | 생략 | provider/model 선택, 실행 미검증 |

예를 들어 Claude 질문은 `question: { backend: claude-code, model: sonnet, reasoning: high }`, OpenCode 질문은 `question: { backend: opencode, model: openai/gpt-5, reasoning: high }`다. OpenCode 질문 reasoning은 [공식 agent 가이드](https://opencode.ai/docs/agents/)의 OpenAI `reasoningEffort`에 연결한다. 다른 provider에서는 생략하며 잘못된 조합을 조용히 무시하지 않는다. 모델의 계정 접근 권한은 native CLI에서 결정된다.

공통 설정 순서와 `task_types.<유형>.question`, 확정 Step의 `execution.question`도 지원한다. 아직 승인하지 않은 Planner 제안의 Step 설정은 적용하지 않는다. 질문 호출마다 설정을 읽고 실효값/출처를 기록하므로 이후 설정 변경이 이미 열린 창을 바꾸지는 않는다.

일회성 덮어쓰기는 HITL CLI의 `--question-backend`, `--question-model`, `--question-reasoning` 또는 JSON 질문 요청의 backend/model/reasoning으로 지정한다. JSON에서 model/reasoning을 null로 지정하면 상속값을 CLI 기본값으로 되돌린다. 공통 defaults의 timeout/isolation/output_retries는 질문에 적용하지 않으며 `roles.question`에 직접 넣으면 오류다. 읽기 전용·승인 금지는 고정이다.

실효 설정은 기존 실행 입구에 `{"action":"settings","role":"question","taskId":"T-0001"}`을 보내 조회한다. 확정 Step 설정까지 확인하려면 stepId도 지정한다. 설정 설계는 [ADR-0023](adr/0023-question-ai-settings.md)에 있다.

**질문 시점의 결과 기준**이라는 표시와 정확한 문서 버전·코드 SHA, 원래 Context·Decision·작업 노트·Gate·Feedback을 새 창에 제공한다. 코드는 Git 객체에서 읽으며 진행 중 worktree의 최신 내용을 섞지 않는다. 원래 세션의 기록되지 않은 사고 과정을 복구하지 않는다.

자료는 별도 디렉터리에 제공한다. Codex는 read-only sandbox, Claude는 restricted·Read/Glob/Grep만 허용·dontAsk·MCP 차단, OpenCode는 기본 deny·읽기 도구 allow·외부 디렉터리 deny인 전용 agent를 사용한다. OpenCode의 실제 권한 동작은 미검증이다. 별도 native 설정/인증 디렉터리를 사용하며 기존 자격증명 파일은 복사하지 않는다. 질문 창에서 로그인·sandbox 초기 설정이 필요할 수 있다. devflow는 **터미널 실행 인계 후 바로 메뉴로 돌아온다.** 창을 열어 둔 채 승인/수정 요청과 다음 역할 진행이 가능하다. 대화·종료·답변 수집·요약·반영은 하지 않는다. 인계 실패도 Task를 실패로 바꾸지 않으며, 인계 후 오류는 native 창에서 확인한다.

질문 자료와 native CLI 자체 설정/이력은 runner-dir 아래에 남는다. 자동 삭제하지 않으며 대화 종료 여부를 devflow가 판단하지 않는다. 사용자가 필요한 시점에 로컬 자료를 정리한다. 실제 창/쓰기 제한 검증과 모델 대화 검증의 범위는 [Runner 계약](design/runner.md)에 구분했다.

## 중단과 남은 범위

unknown 실행은 원래 머신과 runner-dir에서 확인한다. 예약이나 시작 표식을 지워 재시작하지 않는다. 종료가 확인된 실패 Run도 자동 대체하지 않는다. 검증이 worktree를 바꿨다면 실패 Gate를 기록하고 변경을 보존한다. 다음 Worker 전에 사람이 변경을 확인·정리하고 `advance`를 다시 호출한다. Planner 시작도 질문용 코드 버전을 고정할 수 있도록 clean worktree가 필요하다. Planner의 done 승인 후에는 ready_to_complete에서 멈추며 merge/Task done은 기존 별도 절차다. ask_human/rework/abort/Skill 이름 제안은 수용 후 정지하고 새 계획 수정 요청으로 이어갈 수 있다. 전체 제품 CLI·Ledger 자동 생성·실효 요구사항 합성·resume·OpenCode 실제 모델 연동은 이번 완료 범위에 포함하지 않는다.
