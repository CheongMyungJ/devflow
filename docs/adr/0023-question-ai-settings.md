# ADR-0023: 질문 AI도 공통 설정 계층에서 선택

- 상태: Accepted
- 날짜: 2026-09-20

## 배경

독립 질문 CLI의 첫 구현은 backend를 명시하지 않으면 질문 대상 Run의 backend를 사용하고, 같은 backend일 때만 그 모델을 재사용했다. 사용자는 질문 AI도 Worker·Reviewer·Planner·Intake처럼 독립적으로 설정하기를 원한다. 대화 수명 관리와 AI 선택 설정은 별개의 책임이다.

## 결정

- `roles.question`을 공통 설정 계층에 추가한다. 전역/프로젝트 defaults → 각 역할 → 작업 유형 → 확정 Step → 명시 입력의 기존 순서를 사용한다. 질문마다 현재 설정을 해석하며 실효값과 출처를 초기 질문 사건에 기록한다. 이미 인계한 창의 설정은 바꾸지 않는다.
- 설정이 전혀 없을 때 질문 backend의 제품 기본값은 현재 지원하는 codex다. 대상 Run의 backend/model은 상속하지 않는다. backend 변경 시 model/reasoning 상속을 해제하고 null로 CLI 기본값에 되돌리는 기존 규칙을 사용한다.
- question은 설정 선택자이며 관리형 Run의 역할이 아니다. `QuestionSettings`는 backend/model/reasoning만 허용한다. 공통 defaults의 timeout/isolation/output_retries는 질문에 상속하지 않고, 질문 전용 계층에서 지정하면 오류로 거부한다. 읽기 전용·승인 금지 정책은 AI 선택 설정으로 변경할 수 없다.
- Planner가 제안한 아직 미확정 Step의 질문 설정은 적용하지 않는다. 확정된 Step은 작업 유형과 `execution.question`을 사용할 수 있다.
- Runner의 질문 요청으로 model/reasoning을 전달한다. backend별 변환과 호환성 검사는 어댑터 안에 둔다. Codex는 기존 관리형 실행과 같은 모델/추론 조합 검사를 사용한다.

## 결과

전역 파일의 `roles.question`, 프로젝트 `.devflow.yaml`의 `execution.roles.question`, 공통 settings 조회와 질문 실행 입력에서 같은 설정을 사용한다. 독립 인계·즉시 복귀·Run/대화/종료/답변 미관리 계약은 ADR-0022 그대로다. 설정에 backend 이름을 쓸 수 있다는 사실은 해당 backend의 질문 기능 지원을 뜻하지 않는다. 현재 지원은 Windows/Codex 0.154.0이며 나머지는 명시적으로 거부한다.
