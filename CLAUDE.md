# devflow 작업 규칙

구조는 `docs/architecture.md`, 결정 배경은 `docs/adr/` 참조. 아래는 위반하면 안 되는 제약이다.

## 구조 제약 (서버 확장성을 위한 경계 — ADR-0005)

1. CLI/UI 코드는 `commands.*` / `queries.*` 함수만 호출한다. State Store 나 데이터 파일을 직접 읽고 쓰지 않는다.
2. State Store 는 인터페이스 뒤에 둔다. 파일 경로·파일 포맷 지식은 파일 구현체 밖으로 새지 않는다.
3. 상태 기록에 절대 경로·로컬 경로를 저장하지 않는다. 문서는 `artifact://<task>/<step>/<name>@v<N>`, 코드는 `repo + branch + commit SHA` 로 참조한다.
4. Role Runner 는 `submit → run_id`, `result(run_id)`, `stream(run_id)`, `send_message(run_id, text)` 인터페이스로만 사용한다. Orchestrator 는 동기 실행을 가정하지 않는다.
5. `advance(task_id)` 는 멱등이어야 한다. 몇 번 호출해도 결과가 같아야 한다.

## 동작 제약

6. 상태 전이는 시스템(Orchestrator)만 한다. AI 출력은 제안이며, 스키마 검증을 통과해야 반영된다.
7. 이벤트는 append-only. 기존 이벤트를 수정·삭제하지 않는다.
8. 승인은 항상 특정 Artifact 버전을 명시한다.
9. 사람이 세션에 보내는 메시지는 이벤트로 기록된 뒤 세션에 전달된다 (ADR-0006).
10. Step 의 `verify` 는 deterministic/semantic 중 하나 이상 필수. deterministic 이 비어 있으면 approval 은 `required` 로 강제한다 (ADR-0003).

11. Task 하나는 repo 하나, worktree 하나. Worker 와 Gate 는 해당 Task 의 worktree 밖에서 실행하지 않는다 (ADR-0008).

## 문서 규칙

- 구조를 바꾸면 `docs/architecture.md` 를 현재 상태로 덮어쓰고, 이유는 새 ADR 로 남긴다. 기존 ADR 은 수정하지 않는다(대체 시 `Superseded by` 표시만).
- 엔티티 필드 설명은 `schemas/*.json` 의 description 에 쓴다. 별도 설명 문서를 만들지 않는다.
- 역할 프롬프트/스키마/Skill 변경은 코드 변경과 동일하게 다룬다.
