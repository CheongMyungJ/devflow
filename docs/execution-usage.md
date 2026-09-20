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
```

모델 이름은 사용 계정·CLI가 지원하는 값으로 지정한다. backend별 추론 옵션은 의미와 지원 범위가 다르며 미지원 값은 거부한다. OpenCode의 추론 variant는 아직 검증하지 않았으므로 지정하면 오류다. 설정을 생략한 기존 fake 사용법도 유지한다.

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

여기서 **검증**은 시스템의 테스트 실행(deterministic)과 Reviewer의 요구사항·범위 확인(semantic)을 뜻한다. **결과 검토**는 사람이 산출물·검증 결과를 읽고 승인하거나 수정을 요청하는 HITL 단계다. 현재 구현은 Reviewer 실행·결과 기록까지이며 deterministic 명령 자동 실행은 R05의 후속이다.

이 입구가 승인 후 다음 역할을 자동 선택하지는 않는다. `advance`, 제품용 `task review`, 역할별 HITL은 후속 작업이다. 최신 후속 방향은 “승인 / 수정 요청”과 보조 기능 “질문 CLI 열기”다. 독립 질문 CLI는 읽기 전용이며 devflow는 실행 인계 후 즉시 복귀하고 대화·종료·답변 수집을 관리하지 않는다. 질문 창을 닫아야 본 흐름을 진행하는 구조도 아니다. 아직 구현된 기능은 아니며, [후속 작업 프롬프트](handoff-hitl.md)에 범위와 현재 코드에서 바꿀 지점을 정리했다.
