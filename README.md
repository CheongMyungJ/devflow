# devflow

사람 + AI + 시스템이 함께 SW 개발 업무를 수행하는 시스템.

- 사람: Task 발행, AI 산출물에 대한 피드백(수정 요청/질문/승인/요구사항 추가)
- AI: Intake / Worker / Quality Reviewer / Planner — 각각 독립된 일회용 세션
- 시스템: 상태 관리, 상태 전이, Context 조립, 검증 실행, AI 세션 호출

## 문서

| 위치 | 내용 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 현재 구조 (항상 현재 상태만 기술) |
| [docs/roadmap.md](docs/roadmap.md) | 단계별 목표와 다음 단계로 넘어가는 기준 |
| [docs/adr/](docs/adr/) | 결정 기록 (변경 불가, 번호순) |
| [docs/retro/](docs/retro/) | Task 회고 — 개선 작업의 근거 |
| [AGENTS.md](AGENTS.md) | 이 repo 에서 작업하는 AI 도구의 기준 지침 (`CLAUDE.md` 는 이를 참조) |
| [schemas/](schemas/) | Task/Step/Feedback/GateResult/Decision/Event 의 기준 정의 |
| [roles/](roles/) | 역할별 프롬프트 |
| [skills/](skills/) | Step 템플릿 (운영 중 추출, 처음에는 비어 있음) |

## 관련 저장소

- `devflow-data` — Task 실행 데이터 (task.yaml, 산출물, Feedback, Gate 결과, transcript)
- 대상 프로젝트 repo — 코드 산출물은 task branch 에만 존재. `.devflow.yaml` 에 build/test 명령 정의
