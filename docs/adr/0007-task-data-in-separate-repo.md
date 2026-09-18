# ADR-0007: Task 데이터는 별도 repo 에

- 상태: Accepted
- 날짜: 2026-09-18

## 상황
초기 제안은 Task 데이터를 대상 repo 안의 `.tasks/` 에 두는 것이었다.

## 결정
- Task 실행 데이터(task.yaml, 산출물, Feedback, Gate 결과, transcript, events.jsonl)는 별도 git repo `devflow-data` 에 둔다. Step 전이마다 자동 commit 한다.
- 대상 repo 에는 `.devflow.yaml`(build/test 명령, 환경)과 task branch 만 존재한다.
- 설계 문서·스키마·역할 프롬프트·Skill 은 `devflow` repo 에 두고, 서버화 이후에도 git 에서 관리한다.
- Task 이벤트에 실행 당시 `devflow` repo 의 commit SHA 를 기록한다.

## 이유
대상 프로젝트 이력에 transcript·이벤트 로그가 섞이지 않는다. 여러 대상 repo 의 Task 를 한곳에서 관리한다. DB 이전 시 대상 repo 를 건드리지 않는다. git 이라 이력·백업·동기화를 그냥 얻는다.

## 포기한 대안
- 대상 repo 내 `.tasks/`: 단일 repo 에서는 편하지만 위 문제가 모두 발생한다.
- 처음부터 DB: MVP 에서 사람이 에디터로 직접 읽고 고칠 수 있는 이점을 잃는다.
