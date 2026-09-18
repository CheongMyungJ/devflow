# ADR-0003: 검증은 Step 마다 선언한다

- 상태: Accepted
- 날짜: 2026-09-18

## 상황
초기 제안은 "deterministic 검증(build/test/lint)을 항상 먼저 수행" 이었다. 그러나 개발 계획 수립, 원인 분석, 연구성 Step 에는 build/test 가 의미 없다.

## 결정
- Gate 는 고정 파이프라인이 아니다. Step 의 `verify` 에 선언된 항목만 실행한다.
- `verify.deterministic` 과 `verify.semantic` 중 하나 이상은 필수. 둘 다 비어 있는 Step 은 시스템이 거부한다.
- `verify.deterministic` 이 비어 있고 `approval: optional` 이면 시스템이 `required` 로 강제한다.
- 문서형 산출물에는 가벼운 결정론적 검사(필수 섹션, 참조 경로 실존, AC ID 참조 여부)를 선언할 수 있으나 의무는 아니다.
- Planner 지침: 산출물 성격에 맞는 검증만 선언한다. 코드 변경이 없는 Step 에 build/test 를 넣지 않는다. 코드 Step 은 `.devflow.yaml` 의 기본 명령을 가져다 쓴다.

## 이유
결정론적 검증이 약할수록 사람 승인의 비중을 높인다는 규칙으로, 기계 검증도 사람 검증도 없이 통과하는 Step 을 막는다. 억지로 검사를 채우게 하면 형식적 검사만 늘어난다.

## 포기한 대안
- 모든 Step 에 공통 검증 파이프라인 적용.
