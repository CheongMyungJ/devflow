# devflow

사람 + AI + 시스템이 함께 SW 개발 업무를 수행하는 시스템.

- 사람: Task 발행, AI 산출물에 대한 피드백(수정 요청/질문/승인/요구사항 추가)
- AI: Intake / Worker / Quality Reviewer / Planner — 각각 독립된 일회용 세션
- 시스템: 상태 관리, 상태 전이, Context 조립, 검증 실행, AI 세션 호출

## 문서

| 위치 | 내용 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 현재 구조 (항상 현재 상태만 기술) |
| [docs/roadmap.md](docs/roadmap.md) | 현재 구현 수준, 남은 작업의 단일 목록, 다음 작업 순서와 단계별 기준 |
| [docs/design/workspace.md](docs/design/workspace.md) | Workspace 준비·조회와 중단 후 복구 계약 |
| [docs/execution-usage.md](docs/execution-usage.md) | 역할 실행, HITL 승인·수정 요청, 독립 읽기 전용 질문 CLI |
| [docs/adr/](docs/adr/) | 결정 기록 (변경 불가, 번호순) |
| [docs/retro/](docs/retro/) | Task 회고 — 개선 작업의 근거 |
| [AGENTS.md](AGENTS.md) | 이 repo 에서 작업하는 AI 도구의 기준 지침 (`CLAUDE.md` 는 이를 참조) |
| [schemas/](schemas/) | Task/Step/Feedback/GateResult/Decision/Event 의 기준 정의 |
| [roles/](roles/) | 역할별 프롬프트 |
| [skills/](skills/) | Step 템플릿 (운영 중 추출, 처음에는 비어 있음) |

## 관련 저장소

- `devflow-data` — Task 실행 데이터 (task.yaml, 산출물, Feedback, Gate 결과, transcript)
- 대상 프로젝트 repo — 코드 산출물은 task branch 에만 존재. `.devflow.yaml` 에 build/test 명령 정의

## Workspace 준비

새 Task의 기준은 원격 기본 branch이며, 이름을 지정해도 출처를 생략하면 원격이다. 로컬 branch는 `target.base_source: local`과 이름을 함께 입력한다. 최초 준비 때 원격을 fetch해 SHA를 고정하고 이후 재호출은 같은 작업공간과 기존 변경을 보존한다.

```sh
npm run issue-task -- <data-dir> <definition.yaml> --actor human:<id>
npm run prepare-workspace -- <data-dir> <task-id> --machine-config <workspace.yaml>
npm run workspace-status -- <data-dir> <task-id> --machine-config <workspace.yaml>
```

프로젝트 등록부와 머신 설정 예시는 [수동 운영 문서](docs/stage0-manual-operation.md)를 참조한다. 겹친 실행은 중단하며, 강제 종료 후 잠금 또는 부분 checkout이 남으면 수동 확인이 필요하다. 자동 삭제·초기화는 하지 않는다.
