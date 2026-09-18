# Roles

역할별 프롬프트 초안. 각 역할은 독립된 일회용 세션에서 실행되며, 입력은 시스템이 조립한 Context 패킷뿐이다.

| 역할 | 입력 | 출력 (스키마) | repo 권한 | 사람 개입 |
|---|---|---|---|---|
| [Intake](intake.md) | 사람과의 대화 | Task (`task.schema.json`) | 읽기 | 실시간 대화 |
| [Worker](worker.md) | Task, Step, 입력 Artifact, 이전 Feedback | Artifact 버전들 + 요약 | **쓰기 (task branch)** | 관찰·개입 가능 |
| [Reviewer](reviewer.md) | Step, Artifact, deterministic 결과 | GateResult 의 semantic 부분 | 읽기 | 관찰만 |
| [Planner](planner.md) | Task, Ledger, 최근 GateResult, Skill 카탈로그 | Decision (`decision.schema.json`) | 읽기 | Step 제안 확인 단계에서 |

프롬프트를 바꿀 때는 근거가 된 회고(`docs/retro/`)를 commit 메시지에 적는다.
