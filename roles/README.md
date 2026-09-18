# Roles

역할별 프롬프트 초안. 각 역할은 독립된 일회용 세션에서 실행되며, 입력은 시스템이 조립한 Context 패킷뿐이다(Intake 는 사람과의 대화).

| 역할 | 입력 | 출력 (스키마) | repo 권한 | 사람 개입 |
|---|---|---|---|---|
| [Intake](intake.md) | 사람과의 대화 | Task (`task.schema.json`) | 읽기 | 실시간 대화 |
| [Worker](worker.md) | Task, Step, 입력 Artifact, 이전 Feedback | Artifact 버전들 + 보고 (`worker-output.schema.json`) | **쓰기 (task branch)** | 관찰·개입 가능 |
| [Reviewer](reviewer.md) | Step, Artifact, Worker 의 작업 노트, deterministic 결과 | Reviewer 출력 (`reviewer-output.schema.json`) — 시스템이 GateResult 로 기록한다 | 읽기 (Workspace 에서 검사를 실행할 수 있고 실행으로 생기는 git 이 무시하는 생성물은 괜찮다. 추적 파일과 실제 기록은 고치지 않는다. 임시 파일과 고쳐 보는 확인은 Workspace 밖에 자신이 만든 임시 디렉터리 하나에서만) | 관찰만 |
| [Planner](planner.md) | Task, Ledger, 최근 GateResult, Skill 카탈로그 | Decision (`decision.schema.json`) | 읽기 | Step 제안 확인 단계에서 |

## 공통 규칙 (ADR-0010)

- 프롬프트는 도구 중립적으로 쓴다. 특정 AI 도구의 tool 이름이나 기능을 언급하지 않는다.
- 구조화된 출력은 Context 패킷이 지정한 출력 디렉터리에 JSON 파일로 쓴다. 시스템이 스키마로 검증하고, 실패하면 받아들이지 않고 오류와 함께 다시 요청한다.
- Planner, Worker, Reviewer 는 출력의 `packet_gaps` 에 받은 Context 패킷에서 부족했거나 모호했던 점을 문장의 배열로 적는다. 항상 적는다 — 부족한 것이 없었으면 빈 배열. 로컬 경로를 쓰지 않는다. 시스템이 그 Run 의 `packet_gaps` 로 옮긴다. Intake 는 적지 않는다(입력이 Context 패킷이 아니다).
- 백엔드(Claude Code, Codex …)와 모델은 역할별로 설정한다. Reviewer 는 항상 새 세션에서 실행한다.

프롬프트를 바꿀 때는 근거가 된 회고(`docs/retro/`)를 commit 메시지에 적는다.
