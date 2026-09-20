# Roadmap

각 단계는 "넘어가는 기준" 을 충족했을 때만 다음으로 간다. 기준 충족 여부는 `retro/` 의 기록으로 판단한다.

## 0단계 — 수동 조율 (기록 명령은 T-0006에서 구현)

사람과 Orchestrator 대화 세션이 흐름을 조율하고 Planner·Worker·Reviewer를 별도 세션으로 실행한다. T-0006까지 기록은 손으로 썼고, 다음 Task부터는 Store 위의 운영 명령이 엔티티·상태·이벤트를 함께 쓴다. Ledger와 세션 실행·판단 연결·git commit은 아직 수동이다.

목적: 스키마의 과부족과 Context 패킷에 실제로 필요한 내용을 가장 빨리 찾는다.

첫 Task: `schemas 확정 → Store 인터페이스 + 파일 구현체 → commands/queries → task status`

- [x] 구현 언어/런타임 결정 — TypeScript + Node LTS (ADR-0009)
- [x] 프로젝트 골격: 스키마 → 타입 생성, Runner 인터페이스
- [ ] 스키마 초안을 실제 Task 1~2개에 적용해 보고 수정 — T-0001 에 적용해 과부족을 찾았다(F1~F12 는 `design/store.md` 5절, 그 뒤의 것은 `retro/T-0001.md` 와 `devflow-data` 의 backlog). 수정의 첫 묶음(역할 세션 사이를 오가는 것 — Gate 의 지적 구조화, annotations, Run 의 수행 주체, packet_gaps, inputs 의 문법)은 T-0003 에서 했다(ADR-0012). 둘째 묶음(Task 양식의 의도의 칸과 두 단계 Intake)은 T-0004 에서 했다(ADR-0013, 0014). 셋째 묶음(생성 타입의 배열, next_step.step 검사, F6·F9·F12, Artifact meta 검사, 스키마 로더 하나)은 T-0005 에서 했다(ADR-0015, 0016). 나머지는 backlog 2번에 남아 있다
- [x] Store 인터페이스 + 파일 구현체 — T-0001 (Task 와 Event), T-0005 (Step, Decision, Feedback, GateResult, Run, Artifact, blob, Task 안의 ID 발급, 덮어쓰기 방지, commit 식별자 — ADR-0015)
- [x] commands / queries 최소 집합 — T-0001 (`createTask`, `getTask`, `listTasks`)
- [x] 0단계 기록을 Store·commands 위로 — T-0006 (Task 발행·Step 한 바퀴·done, 입구 입력 검사, validator·Store 이름 규칙, ADR-0017). Ledger 자동 작성은 제외

**T-0006 종료 시점:** 수동 Task는 T-0001~T-0006의 6개다. T-0006은 실행 Step 4개·재작업 2회·역할 출력 18개 모두 첫 수용이었다. merge 뒤 Windows 빌드 캐시 EPERM은 사람 지시로 Codex가 직접 보완하고 594 tests를 통과했다(`retro/T-0006.md`). 스키마 수정은 범위 밖이었고 stored_in·참조·Feedback 전달 등 후속이 남아 있으므로, 변경이 없었다는 이유만으로 안정화·1단계 진입을 선언하지 않는다. 다음 후보는 Workspace 최소 기능이며 단계 전환과 범위는 다음 Intake에서 정한다.

아래는 T-0005까지의 판단 경과다.

수동으로 끝까지 수행한 Task: T-0001, T-0002, T-0003, T-0004, T-0005 (5 / 2~3). T-0005 는 새 Task 양식의 첫 Task 이고 Step 넷·재작업 0·역할 출력 13개가 모두 한 번에 받아들여졌다(`retro/T-0005.md`). 스키마 변경은 T-0005 에서도 있었으나 이번에는 새 과부족이 스키마보다 운영(Feedback 을 가리킬 자리, "다음 Step 에서 반드시" 의 자리)과 1단계 설계(검토 요청의 형식, approval 정책)에서 나왔다. T-0002 부터 Planner·Worker·Reviewer 를 모두 Context 패킷만 받은 별도 세션으로 실행한다. T-0003 은 코드 변경이 있고 여러 Step 에 걸친 Task 에서 그 분리가 성립함을 확인했다(`retro/T-0003.md`). **스키마 변경은 시작되었고 아직 잦아들지 않았다** — T-0003 이 스키마를 바꾸면서 새 과부족이 또 나왔고(backlog 2번), Intake·Task 양식의 변경을 T-0004 에서 했다(재작업 0, 역할 세션의 출력 일곱이 모두 한 번에 받아들여졌다, Orchestrator 대화 세션의 교체도 기록만으로 성립 — `retro/T-0004.md`). T-0004 에서도 스키마의 새 과부족이 나왔다(의도의 칸의 사후 검사, 생성 타입의 AC). 넘어가는 기준의 앞쪽(Task 2~3개)은 찼고 뒤쪽(스키마 변경이 잦아들었다)은 아니다.

**넘어가는 기준**: 수동으로 Task 2~3개를 끝까지 수행했고, 스키마 변경이 잦아들었다.

## 1단계 — MVP (전체 루프를 얇게)

범위: 사용자 1명, Task 당 repo 1개(프로젝트와 동시 진행 Task 는 여러 개 가능), Task 안에서는 Step 순차 실행, 작은 버그 수정·소규모 기능. Skill 0개.

- [x] 신규 Worker/write 어댑터: `fake`, `claude-code`, `codex`, `opencode` + 공통 실행 관리 (ADR-0020). Claude Code/Codex 실제 세션과 호출자 종료 후 회수 확인. OpenCode는 계약 테스트 완료, 실제 연동 미검증. 다른 역할과 아래 후속 기능은 제외
- [x] fake Worker 실행 관리: 명시적 입력, Task/Run/UUID 식별, detached supervisor, 호출자 종료 후 상태/결과 회수, 멱등 수집 (ADR-0019). 실제 AI·resume·메시지·자동 재시도는 제외
- [x] 네 어댑터의 출력 파일 스키마 검증과 멱등 수집, 실행 후 Git SHA 확정 (`workspace:code`)
- [ ] 출력 자동 재시도, 읽기 전용 실행의 worktree 변경 검사
- [ ] resume 경로와 새 세션 대체 경로, Run 기록
- [ ] transcript 정규화 (`task attach` / `task log` 표시용)
- [ ] Orchestrator: 멱등 `advance()`, 재작업·Step 수 상한
- [ ] Gate: `.devflow.yaml` 의 명령 실행 + AI 리뷰 1회
- [ ] CLI: `task new / run / status / review / answer / attach / log`
- [x] Workspace 최소 기능: Task별 worktree 준비·조회, 원격/로컬 기준 선택, SHA 고정, 정상 단계 경계의 중단 후 복구 (ADR-0018)
- [x] 준비된 Workspace와 네 Worker Runner 연결 (ADR-0019, ADR-0020)
- [ ] Workspace 후속: 자동 정리, base branch 이동을 Planner에 전달. Git 생성 도중의 불완전 상태는 현재 수동 확인
- [ ] `task status`: Task 전체에 걸친 "내 입력 대기" 목록
- [ ] `devflow-data` 의 git commit 직렬화, `exclusive` 프로젝트의 Gate 직렬화 (Task ID 발급은 lock 없이 `mkdir` 로, Task 별 Store commit 의 직렬화는 T-0001 에서 구현 — ADR-0011)
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
- OpenCode 실제 연동 검증과 백엔드별 운영 경험 축적 (Worker/write 어댑터와 대역 계약 테스트는 ADR-0020에서 완료)
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
