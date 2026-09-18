# Roadmap

각 단계는 "넘어가는 기준" 을 충족했을 때만 다음으로 간다. 기준 충족 여부는 `retro/` 의 기록으로 판단한다.

## 0단계 — 수동 운영 (도구 없음)

사람이 Orchestrator 역할을 직접 한다. 시스템 구현 작업 자체를 Task 로 정의하고, Step yaml 을 직접(또는 AI 에게 Planner 역할로) 작성해 Claude Code 세션에서 하나씩 실행한다. 결과는 `devflow-data` 에 손으로 저장한다.

목적: 스키마의 과부족과 Context 패킷에 실제로 필요한 내용을 가장 빨리 찾는다.

첫 Task: `schemas 확정 → Store 인터페이스 + 파일 구현체 → commands/queries → task status`

- [x] 구현 언어/런타임 결정 — TypeScript + Node LTS (ADR-0009)
- [x] 프로젝트 골격: 스키마 → 타입 생성, Runner 인터페이스
- [ ] 스키마 초안을 실제 Task 1~2개에 적용해 보고 수정
- [ ] Store 인터페이스 + 파일 구현체
- [ ] commands / queries 최소 집합

**넘어가는 기준**: 수동으로 Task 2~3개를 끝까지 수행했고, 스키마 변경이 잦아들었다.

## 1단계 — MVP (전체 루프를 얇게)

범위: 사용자 1명, Task 당 repo 1개(프로젝트와 동시 진행 Task 는 여러 개 가능), Task 안에서는 Step 순차 실행, 작은 버그 수정·소규모 기능. Skill 0개.

- [ ] Role Runner + 어댑터 3종: `fake`(테스트용) → `claude-code` → `codex` (ADR-0010)
- [ ] 출력 파일 스키마 검증·재시도, 읽기 전용 실행의 worktree 변경 검사
- [ ] resume 경로와 새 세션 대체 경로, Run 기록
- [ ] transcript 정규화 (`task attach` / `task log` 표시용)
- [ ] Orchestrator: 멱등 `advance()`, 재작업·Step 수 상한
- [ ] Gate: `.devflow.yaml` 의 명령 실행 + AI 리뷰 1회
- [ ] CLI: `task new / run / status / review / answer / attach / log`
- [ ] Workspace 관리자: Task 별 worktree 생성·정리, 프로젝트 등록부, base branch 이동 감지
- [ ] `task status`: Task 전체에 걸친 "내 입력 대기" 목록
- [ ] Store lock (Task ID 발급, data commit 직렬화), `exclusive` 프로젝트의 Gate 직렬화
- [ ] Task Ledger 갱신
- [ ] Step 전이마다 `devflow-data` 자동 commit
- [ ] dogfooding 시작 + 실제 업무 repo 1개에 병행 적용

**넘어가는 기준**: 실제 Task 10~20개 수행.

## 2단계 — 안정화

- 회고에서 반복 패턴을 Skill 로 추출, Skill 버전 관리
- Ledger 요약 품질 개선
- 재작업·비용 한도 조정
- 실패 사례 기반 역할 프롬프트 개선, 프롬프트 버전 태그
- 백엔드별·세션 경로별(resume vs 새 세션) 재작업률 비교 → 역할별 백엔드 배정, 작업 노트 품질 개선
- 세 번째 어댑터(opencode 등)
- 회고 초안을 `events.jsonl` 에서 자동 생성

**넘어가는 기준**: 최근 10개 Task 에서 Planner Step 제안 수정률 10% 미만 → `--auto-plan` 기본값 전환.

## 3단계 — 업무 확장

- 연구성 Task, 복잡한 불량 분석 (가설 → 실험 반복)
- 대규모 기능: Task 를 하위 Task 로 분해
- `approval: optional` 확대 (저위험 Step 자동 통과)
- 실행 중 개입 내용의 자동 분류 (Step 피드백 vs Task 요구사항)
- 대상 repo 확대

**넘어가는 기준**: 여러 Task 유형에서 안정 동작. Task 수 증가로 파일 기반 조회가 느려지거나 팀 사용 필요가 생김.

## 4단계 — 시스템 확장

- commands/queries 를 HTTP API 뒤로, CLI 는 클라이언트로
- Store: 파일 → DB + object storage (`events.jsonl` 재적재로 이전)
- Runner: job queue + 컨테이너, 서버 Workspace, credential 관리
- 이벤트 기반 자동 `advance`, 알림
- 웹 UI, 다중 사용자·권한, 낙관적 잠금
- PR 연동 (PR 코멘트 → Feedback, PR approve → Step 승인), 이슈 트래커·CI 연동
- 독립 Step 병렬화

## 의도적으로 미루는 것

Step DAG·병렬 실행, Skill 레지스트리, 멀티 에이전트 협업, 범용 플러그인 구조. 모두 단일 Step 스키마와 append-only 상태 위에 나중에 얹을 수 있다.

## MVP 에서 집중 관찰할 위험

1. Planner 가 검증 가능한 크기로 Step 을 자르는가
2. Context 패킷만으로 새 세션의 Worker 가 충분히 작업할 수 있는가
