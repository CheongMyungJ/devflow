# ADR-0002: Step 스키마는 하나, Skill 은 템플릿

- 상태: Accepted
- 날짜: 2026-09-18

## 상황
Step 의 수와 종류는 미리 고정하지 않고 Planner 가 하나씩 결정한다. 반복 패턴은 Skill 로 정형화하되, 자유도 높은 Freeform Step 도 함께 써야 한다.

## 결정
- Step 정의 스키마는 하나만 둔다: goal / scope / inputs / outputs / done_when / verify / approval.
- Freeform 은 Planner 가 전 필드를 작성한다. Skill 은 파라미터가 있는 Step 템플릿 + Worker 지침 + 기본 검증이며, 시스템이 완전한 Step 정의로 펼친다.
- 펼친 뒤의 실행 경로는 동일하다. Skill 을 아는 곳은 Planner 의 카탈로그와 시스템의 전개 단계뿐이다.
- Skill 은 미리 설계하지 않는다. 회고에서 비슷한 Freeform Step 이 3~4회 반복되고 승인률이 높을 때 승격하며, 버전을 붙인다.

## 이유
실행 경로가 하나라 Worker/Reviewer/Orchestrator 가 단순하다. Skill 없이도 시스템이 완전히 동작하므로 MVP 를 Skill 0개로 시작할 수 있다.

## 포기한 대안
- Task 유형별 고정 워크플로: 다양한 업무에 확장하기 어렵다.
- Skill 과 Freeform 을 별도 실행 경로로 구현: 두 경로를 모두 유지해야 한다.
