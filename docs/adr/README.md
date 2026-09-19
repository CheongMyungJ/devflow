# ADR (Architecture Decision Records)

결정 하나당 파일 하나. 번호순. 한 번 쓴 ADR 은 수정하지 않는다. 결정이 바뀌면 새 ADR 을 쓰고, 기존 ADR 의 상태만 `Superseded by ADR-NNNN` 으로 바꾼다.

## 템플릿

```markdown
# ADR-NNNN: 제목

- 상태: Accepted | Superseded by ADR-NNNN
- 날짜: YYYY-MM-DD

## 상황
## 결정
## 이유
## 포기한 대안
```

10~20줄이면 충분하다.

## 목록

| # | 제목 |
|---|---|
| [0001](0001-stateless-sessions-external-state.md) | AI 세션은 일회용, 상태는 외부 append-only 저장소에 |
| [0002](0002-single-step-schema-skill-as-template.md) | Step 스키마는 하나, Skill 은 템플릿 |
| [0003](0003-verification-declared-per-step.md) | 검증은 Step 마다 선언한다 |
| [0004](0004-checks-before-human-review.md) | 검증은 사람 검토 전에, 승인은 버전을 명시해서 |
| [0005](0005-extension-seams.md) | 서버 확장을 위한 다섯 가지 경계 |
| [0006](0006-live-intervention-via-events.md) | 세션 관찰·개입 허용, 개입은 이벤트로 기록 |
| [0007](0007-task-data-in-separate-repo.md) | Task 데이터는 별도 repo 에 |
| [0008](0008-multi-project-and-concurrent-tasks.md) | 여러 프로젝트, 동시 진행 Task |
| [0009](0009-typescript-node.md) | TypeScript + Node.js LTS |
| [0010](0010-backend-neutral-runner.md) | 백엔드 중립 Runner, resume 은 최적화로만 |
| [0011](0011-file-store-decisions.md) | Store 파일 구현체의 결정 (ADR-0008 결정 4 의 일부를 대체) |
| [0012](0012-role-interface-schemas.md) | 역할 출력의 스키마, packet_gaps 의 자리, 옛 형식 기록과의 공존 |
| [0013](0013-task-intent-fields.md) | Task 정의에 의도의 칸, AC 는 성공 기준을 가리킨다, 사람이 답할 질문이 남으면 발행되지 않는다 |
