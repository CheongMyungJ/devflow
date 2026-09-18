# ADR-0008: 여러 프로젝트, 동시 진행 Task

- 상태: Accepted
- 날짜: 2026-09-18

## 상황
대상 프로젝트는 여러 개가 될 수 있고, 여러 Task 가 동시에 진행될 수 있다(같은 repo 안에서도). 상태는 이미 Task 단위로 분리되어 있으나 작업 공간, 데이터 commit, repo 식별, 여러 repo 에 걸친 작업은 정해져 있지 않았다.

## 결정
1. **Task 당 worktree 하나.** Worker 와 Gate 는 그 Task 의 worktree 안에서만 실행한다. 경로는 Workspace 관리자가 `task_id → 경로` 로 실행 시점에 풀어 주며 상태 기록에 남기지 않는다.
2. **Task 당 repo 하나.** 여러 repo 에 걸친 작업은 사람이 Task 를 나눠 발행한다. 연계가 잦아지면 3단계의 하위 Task 분해로 푼다.
3. **프로젝트 등록부.** 프로젝트 이름 → remote URL·기본 branch 매핑은 `devflow-data/projects.yaml` 에 둔다. 로컬 clone 위치는 머신별 설정 파일에 두고 공유 데이터에 넣지 않는다.
4. **data commit 직렬화.** Store 파일 구현체는 Task ID 발급과 `devflow-data` commit 구간에 파일 lock 을 건다.
5. **worktree 밖 자원을 쓰는 프로젝트**(포트, 로컬 DB, 공유 build 캐시)는 `.devflow.yaml` 에 `exclusive: true` 를 선언하고, 시스템은 그 프로젝트의 Gate 를 직렬로 실행한다.
6. **base branch 이동 감지.** `advance` 는 Task 의 base branch 가 움직였는지 확인해 Planner 입력에 포함한다. 충돌 해결·재검증은 Planner 가 Step 으로 만든다. 시스템은 동시 수정을 막지 않는다.
7. `task status` 는 Task 전체에 걸쳐 "사람 입력을 기다리는 것" 을 보여 준다. 동시 실행 수 상한은 전역 설정으로 둔다.

## 이유
Gate 와 승인의 단위가 repo 와 일치해 단순하다. lock 과 worktree 는 파일·로컬 구현체의 세부 사항이라 서버화(DB, 컨테이너) 시 자연히 대체된다. 동시 수정 충돌은 일반 개발에서도 merge 시점에 해결하는 문제이므로 같은 방식으로 다룬다.

## 포기한 대안
- `task.target` 을 배열로: Step·Gate·Artifact 가 모두 "어느 repo 인가" 를 명시해야 해 스키마 전체가 무거워진다.
- 작업 디렉터리 공유 + branch 전환: 동시 진행 시 서로의 작업을 깨뜨린다.
- scope 가 겹치는 Task 의 동시 진행 차단: 과한 제약. 발행 시 경고는 나중에 추가한다.
