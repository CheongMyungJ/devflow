# ADR-0022: 역할별 HITL과 독립 읽기 전용 질문 CLI

- 상태: Accepted
- 날짜: 2026-09-20
- ADR-0006의 메시지 선기록 범위와 ADR-0021의 후속 HITL 제안을 아래 범위에서 대체한다.

## 배경

사용자는 Planner·Worker·Reviewer 각각의 결과 직후에 승인/수정 요청을 선택하고, 보조 수단으로 새 질문 CLI를 열기를 원한다. 질문 창 종료를 기다리거나 답변을 본 흐름에 동기화하는 방식은 이번 요청과 맞지 않는다. 기존 역할 Run 수집만으로는 사람의 대기 대상이나 다음 동작이 영속적으로 표현되지 않는다.

## 결정

1. Task에 Orchestrator 소유의 진행 커서를 두고 이벤트와 같은 CAS commit으로 갱신한다. `startWorkflow`는 열린 Step이 없거나 이미 정의한 Step 하나인 Task에서 시작하며 기존 개별 실행을 자동 채택하지 않는다. 역할별 HITL 기본값은 켜짐이다. 역할 설정 계층은 기존 Runner 설정을 사용하고 HITL 정책은 시작 설정에서 고정한다.
2. 외부 역할/검증 실행 전에 action UUID와 필요한 Run ID를 예약한다. `advance`는 실행을 기다리는 루프가 아니라 제출·관찰·종료 결과 수집을 수행한 뒤 실행 중 또는 HITL에서 반환하는 유한한 조율기다. 같은 커서에는 같은 실행만 제출한다. 불명확한 시작·종료는 자동으로 대체하지 않는다. 수집과 HITL 커서 갱신 사이에 중단되면 완료 Run에서 같은 결과를 회수한다.
3. HITL 응답은 현재 대상 객체 전체(역할·결과 ID·Artifact 버전 집합)를 대조한다. 동일 사용자의 동일 응답 재전송은 기존 영수증 조회이며 다시 진행하지 않는다. 다른 응답이나 오래된 대상은 거부한다. 역할 수용 사건과 최종 Artifact 승인 사건을 구별한다.
4. Planner 수정은 기존 proposed Step을 취소하고 새 세션·Decision·Step을 만든다. Decision의 대체 관계는 시스템이 기록한다. Worker 수정은 같은 Task worktree에서 새 Artifact 버전을 만든다. Reviewer는 판정을 먼저 기록하고 checking에서 기다린다. 판정 수용 시 pass는 다음 검토, fail은 Worker 재작업으로 간다. 검토 판단 재검토는 같은 버전에 새 Reviewer와 새 Gate를 만들며 이전 Gate를 보존한다.
5. Worker 수용 뒤 Step에 선언된 deterministic → semantic 검증만 실행한다. deterministic 결과는 별도 Verifier 인터페이스의 시스템 실행이며 AI Run으로 가장하지 않는다. 실행 로그는 로컬에, 종료 결과는 공유 기록에 둔다. 필수 최종 Artifact 승인은 역할별 HITL과 별도이며 deterministic이 없으면 항상 사람의 승인을 요구한다. 자동 흐름을 시작한 Task에서 기록 전용 명령으로 이 대기를 우회하지 못한다.
6. 질문은 `Runner.openQuestion`이라는 별도 인계 계약이다. 정확한 문서 버전의 blob과 Git commit 객체에서 읽은 자료를 독립 디렉터리에 만든다. 작업 중 worktree를 복사하거나 링크하지 않는다. backend 권한 제한과 격리된 자료를 함께 사용하며 미확인 backend/환경은 거부한다. 기록된 작업 노트·Context를 설명할 뿐 원래 세션의 미기록 사고 과정을 안다고 하지 않는다.
7. devflow는 초기 질문·대상·인계 시도/결과만 기록한다. 터미널을 실행한 뒤 즉시 반환하며 관리형 Run, Task 잠금, 프로세스 핸들, 대화/종료 감시, 답변 수집·요약·반영을 만들지 않는다. 인계 실패는 Task 상태를 바꾸지 않는다. 인계 이후 인증·모델 오류는 native CLI 책임이다. **이 통로만 ADR-0006의 모든 메시지 선기록에서 제외**하며 관리형 세션의 기존 규칙은 유지한다.
8. 최소 지원은 Windows/Codex 0.154.0이다. 대화형 CLI에는 exec의 설정 차단 플래그가 없으므로 별도의 native 설정 디렉터리와 읽기 전용 sandbox·승인 금지·플러그인/훅 비활성화를 사용한다. 인증 정보는 복사하지 않는다. native 창에서 로그인이나 sandbox 설정이 필요할 수 있다. devflow는 native 자료를 자동 정리하지 않는다. resume와 모델 대화 수명 관리는 범위 밖이다.

## 결과와 한계

승인 뒤 역할 실행은 자동 연결되지만 결과 확인은 `advance` 재호출 또는 HITL CLI의 새로고침으로 한다. 일반 제품 UI·Ledger 자동 조립·Skill 이름만인 제안의 자동 펼치기·종료가 확인된 실패 Run의 자동 재시도·프로젝트 setup/exclusive Gate 조율·merge는 별도다. Planner의 ask_human/rework/abort/Skill 제안은 수용 뒤 설명과 함께 정지하며, 새 계획 수정 요청으로 이어갈 수 있다. 완료 제안 수용도 merge/Task done을 자동 수행하지 않는다.

버린 대안은 질문을 관리형 Run으로 등록하기, 질문 종료까지 승인 막기, 답변을 승인으로 추측하기, 원래 Worker 세션을 resume해 수정하기다. 모두 이번 사용자 합의나 버전/복구 경계에 맞지 않는다.
