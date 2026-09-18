# ADR-0001: AI 세션은 일회용, 상태는 외부 append-only 저장소에

- 상태: Accepted
- 날짜: 2026-09-18

## 상황
Intake/Worker/Reviewer/Planner 는 각각 독립된 세션에서 돈다. 세션은 죽거나 컨텍스트가 넘칠 수 있고, 나중에는 다른 머신에서 실행된다.

## 결정
- 모든 AI 역할을 `(Context 패킷) → (스키마로 검증되는 출력)` 의 1회성 호출로 다룬다.
- Task/Step/Artifact/Feedback/GateResult/Decision 은 State Store 에 저장하고, 변경은 append-only 이벤트로 남긴다.
- 상태 전이는 결정론적 Orchestrator 만 수행한다. AI 출력은 제안이다.
- Planner 에게는 전체 이력 대신 시스템이 관리하는 Task Ledger(요약)를 준다.

## 이유
세션 실패 시 재실행만으로 복원된다. 역할 간 결합이 데이터(스키마)로만 이루어져 역할별 개선·교체가 쉽다. append-only 구조는 저장소 교체(파일→DB)를 재적재로 해결하게 해 준다.

## 포기한 대안
- 장기 실행 세션이 Task 전체를 끌고 가는 방식: 구현은 쉽지만 복원 불가, 컨텍스트 폭발, 역할 독립성 상실.
- AI 가 상태 파일을 직접 수정: 검증되지 않은 전이가 생긴다.
