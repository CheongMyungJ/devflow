# ADR-0021: 역할 실행 설정과 신규 세션의 공통 실행 수명

- 상태: Accepted
- Superseded by [ADR-0022](0022-role-hitl-and-independent-questions.md) — 후속 HITL 화면/세션 접속 제안과 자동 조율 범위.
- 날짜: 2026-09-20

## 배경

Worker 신규 실행의 복구 경로는 있지만 나머지 역할은 기록 command만 있었다. 역할별 설정을 실행과 별도로 만들면 실효값의 적용·재수집을 검증하기 어렵다. 사용자는 R01·R02를 함께 구현하되 이해하기 쉬운 흐름을 원했고, 논의 후 **resume는 후속으로 미루고 모든 역할을 새 세션으로 실행**하기로 했다.

## 결정

1. 기본 흐름은 제출 → 관찰 → 결과 수집이다. 수집된 출력·Artifact를 직접 덮어쓰지 않는다. 수정은 현재 Step의 정식 재작업과 새 Run·새 Artifact 버전으로 처리한다. 다음 Step이 진행된 뒤 옛 Worker를 다시 열어 수정하는 경로는 제공하지 않는다. resume 옵션은 받지 않으며 모든 backend의 supportsResume는 false다. 세션 ID는 진단 자료 연결을 위해 보관할 수 있다.
2. 설정 우선순위는 제품 기본값 → 전역 defaults/역할/작업 유형 → 프로젝트 defaults/역할/작업 유형 → 확정된 Step 역할 설정 → 명시 실행 입력이다. backend가 바뀌면 하위 계층에서 상속한 model/reasoning을 지운다. null은 backend 기본값으로 되돌린다. 실제 CLI가 선택한 기본 모델을 추측해 기록하지 않는다. 필드는 schemas가 정의한다.
3. 전역 설정은 명시적 config 파일 또는 DEVFLOW_CONFIG로 선택한다. 프로젝트 설정은 Task worktree의 .devflow.yaml의 execution이다. 별도 project-config를 지정할 수도 있다. 설정 파일 지식은 settings/file 구현에 있고 commands/queries는 인터페이스를 사용한다. 머신 경로 설정·인증 설정과 역할 정책을 섞지 않는다.
4. 새 제출은 설정 해석 전 입력 digest와 해석 후 입력 digest를 함께 고정한다. 같은 Run의 재제출·관찰·수집은 기록된 backend와 입력을 사용하고 현재 설정을 다시 적용하지 않는다. 프로세스 조립 지점의 RunnerRegistry는 backend별 어댑터를 지연 생성·재사용한다. State Store는 하나다.
5. Planner·Reviewer는 Task worktree에서 read 실행한다. Reviewer는 특정 Artifact 버전들을 필수 입력으로 받는다. 출력은 각각 planner-output/reviewer-output JSON으로 검증한 후 기존 recordDecision/recordGate에 연결한다. Gate의 deterministic 명령 실행과 전체 advance는 이번 기능이 아니다. supplied deterministic 문서는 호출자가 제공한 증거로 구분한다.
6. 관리형 실행은 Task 안에서 한 번에 하나다. 제출 중이거나 결과를 아직 수집하지 않은 실행이 있으면 다른 관리형 실행을 제출하지 않는다. 확인 불가능한 실행을 자동 대체하지 않는다. read 실행은 시작·종료의 파일 내용(ignored 포함), Git HEAD·index를 대조한다. 위반 시 결과를 invalidated로 기록하고 사용자 변경을 남긴다. symlink/junction이 있는 read workspace는 검증 불가로 거부한다. 이 검사는 종료 시점의 불변성 검사이며 악의적 프로세스에 대한 OS 격리의 대체물이 아니다.
7. 공통 supervisor가 취소·timeout·로그 보관·출력 재시도를 관리한다. backend 고유의 입력 메시지/출력 이벤트 형식은 각 어댑터의 protocol 모듈이 해석한다. 취소 의도를 먼저 기록하고 해당 실행을 소유하는 supervisor가 프로세스 트리를 종료한다. 실제 종료를 확인하기 전에는 cancelled/failed로 확정하지 않는다. 출력 재시도는 기본 0이고 명시적으로 제한된 횟수만 허용한다. 불명확한 실행에는 적용하지 않는다.
8. 사람의 live 메시지는 Store 이벤트가 성립한 후에만 어댑터에 전달한다. 전달 ID로 중복을 막으며 쓰기 직전의 로컬 claim 뒤 실패는 전달 여부 불명으로 남긴다. CLI stdin 전달은 모델이 읽었다는 보장이 아니다. Reviewer에는 메시지를 전달하지 않는다. 직접 열린 backend CLI에 입력하는 방식은 이 기록 계약을 만족하지 않는다.
9. 로그는 실행 ID로 연결한 머신별 자료다. stdout/stderr/통합 transcript/정규화 로그를 각각 최대 8 MiB까지 보관하고 자동 삭제하지 않는다. 사용자가 조회 범위를 지정한다. 로그가 잘렸다고 역할 출력 대신 채택하지 않는다. 원본 로그는 프롬프트·코드·경로를 포함할 수 있으므로 공유 Store로 자동 복사하지 않는다.

## Intake의 발행 전 상태

ADR-0014는 수동 Intake에서 별도 초안 엔티티를 두지 않았다. 신규 세션의 자동 실행·중단 후 회수를 지원하려면 Task가 없는 단계도 기록해야 한다. 기존 Task 필수 필드나 Run의 Task 소속을 느슨하게 만들지 않고, 같은 Store의 IntakeRepository 아래에 별도의 발행 전 기록을 둔다.

- 초안은 I-UUID로 식별하고 revision마다 상태·사건·실행 입력·출력을 한 불변 스냅샷으로 게시한다. 파일 구현은 기존 lock/파일 연산을 재사용한다. append-only 사건의 앞부분은 바꿀 수 없다.
- 의도 출력 → 사람이 특정 revision 확인 → 정의 출력 → 사람이 특정 revision 발행의 두 확인을 지킨다. 사람이 답할 질문이 남은 의도는 확정하지 않는다. 정의가 확인된 의도를 바꾸면 거부한다.
- Intake는 Runner가 준비한 비어 있는 전용 cwd에서 read 실행한다. 대상 repo의 코드 조회가 필요하면 호출자가 제공한 Context로 다루며, 임의 clone을 쓰기 workspace로 취급하지 않는다.
- Task 발행은 publish_requested → 기존 createTask → issued의 경계다. 발행된 Task의 생성 이벤트에 초안 버전을 남긴다. 발행 중 중단되면 그 출처로 기존 Task를 찾고 중복 발행을 막는다. 입력 검증 거부로 Task가 생성되지 않았음이 확인되면 publish_rejected를 남기고 정의 수정으로 돌아간다. 결과를 확인할 수 없는 발행은 자동 재시도하지 않는다.

## HITL 화면과의 경계

사용자에게 제안한 화면은 **승인 / 세션 접속**이다. 승인 대상은 항상 검증한 버전이고, 접속 중에는 다음 round로 넘어가지 않는다. 질문만 했다면 원래 결과로 돌아갈 수 있지만 수정했다면 새 버전 검증 뒤 다시 검토한다. 기존 backend CLI를 직접 resume해 여는 방식은 기록과 버전 경계를 보장하지 못한다.

이번 구현의 운영 입구는 설정·역할 실행·상태·수집·취소·로그·지원 backend의 메시지 명령이다. 승인 후 자동 다음 round 진행, HITL 대화 화면, 전체 Orchestrator는 R06·R07에서 이 실행 기반 위에 만든다. 별도의 round 엔티티나 범용 대화 플랫폼을 이번에 도입하지 않는다.
