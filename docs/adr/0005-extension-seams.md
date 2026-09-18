# ADR-0005: 서버 확장을 위한 다섯 가지 경계

- 상태: Accepted
- 날짜: 2026-09-18

## 상황
MVP 는 로컬·단일 사용자·파일 기반이지만, 최종적으로는 서버에서 AI 를 실행하고 로컬에서는 검토·피드백만 한다. MVP 를 제약 없이 만들면 재작성이 필요하다.

## 결정
MVP 부터 다음 경계를 지킨다.

1. **CLI → commands/queries 함수만 호출.** CLI 는 데이터 파일을 직접 읽고 쓰지 않는다. (확장: 함수가 HTTP API 뒤로 이동)
2. **State Store 인터페이스.** `append_event / get_task / put_artifact …` 뒤에 파일 구현체. (확장: DB + object storage)
3. **ID/SHA 기반 참조.** 문서는 `artifact://T/step/name@vN`, 코드는 `repo+branch+SHA`. 절대 경로 저장 금지. Context 패킷은 resolver 로 조립.
4. **Runner 비동기 인터페이스.** `submit → run_id`, `result`, `stream`, `send_message`. (확장: job queue + 컨테이너)
5. **멱등 `advance(task_id)`.** MVP 는 사람이, 확장 후에는 이벤트가 호출한다. 서버 재시작 시 전 Task 에 한 번씩 호출하면 복구된다.

추가: 이벤트에 Task 별 순번을 붙이고, 명령에는 기대하는 현재 상태(예: 승인 대상 버전)를 포함한다. Worker 는 Workspace 밖의 로컬 환경에 의존하지 않으며, build/test 환경은 대상 repo 의 `.devflow.yaml` 에 명시한다.

## 이유
추가 비용은 함수 몇 개를 한 겹 감싸는 정도인데, 지키지 않으면 서버화 시 CLI·저장·실행 계층을 모두 다시 짜야 한다.

## 포기한 대안
- 처음부터 서버/DB/큐 구축: 구조 검증 전에 인프라에 시간을 쓴다.
- 경계 없는 스크립트형 MVP: 빠르지만 버려야 한다.
