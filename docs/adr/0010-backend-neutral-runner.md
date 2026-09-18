# ADR-0010: 백엔드 중립 Runner — Claude Code 와 Codex 를 처음부터 지원

- 상태: Accepted
- 날짜: 2026-09-18
- ADR-0001 의 "세션은 일회용" 을 다음과 같이 구체화한다: **세션은 언제든 버릴 수 있어야 한다. 매번 버리라는 뜻은 아니다.**

## 상황
AI 세션을 실행하는 도구는 Claude Code, Codex, opencode 등 여러 가지가 될 수 있다. 특정 벤더의 SDK 에 묶이면 안 된다. 또한 질문·수정 요청까지 매번 새 세션에 시키면 비효율적이고, 질문의 경우 새 세션은 이유를 추측해서 답할 뿐이다.

## 결정

### 어댑터
- Runner 인터페이스(`submit / result / stream / sendMessage / cancel`) 뒤에 백엔드별 어댑터를 둔다. 어댑터는 각 도구의 **headless CLI 를 subprocess 로** 실행한다.
- MVP 부터 `claude-code`, `codex` 두 어댑터와 테스트용 `fake` 어댑터를 구현한다. 어댑터가 하나뿐이면 추상화가 그 도구에 맞춰 새기 때문이다.
- 어댑터는 능력을 선언한다: `supportsLiveMessage`, `supportsResume`.
- 백엔드·모델은 역할별로(필요 시 Task/Step 별로) 설정하고, 실행 기록에 backend, model, CLI 버전을 남긴다.

| | claude-code | codex |
|---|---|---|
| 실행 | `claude -p --output-format stream-json` | `codex exec --json -C <dir>` |
| 읽기 전용 | `--permission-mode` / `--allowedTools` | `--sandbox read-only` |
| 쓰기 | 편집 도구 허용 | `--sandbox workspace-write` |
| 실행 중 메시지 | `--input-format stream-json` (지원) | 미지원 → 중단 후 resume |
| resume | `--resume <session-id>` | `codex exec resume <session-id>` |

(2026-09-18 기준 Claude Code 2.1.276, codex-cli 0.154.0 에서 확인. 옵션 지식은 어댑터 안에 가둔다.)

### 중립성 규칙
1. **구조화된 출력은 파일로 받는다.** 역할 프롬프트가 "결과를 출력 디렉터리의 `<name>.json` 에 써라" 고 지시하고, 시스템이 스키마로 검증한다. 실패하면 오류를 붙여 재시도한다. 백엔드의 structured output 기능(`--json-schema`, `--output-schema`)에 의존하지 않는다.
2. **권한은 `access: read | write` 로 선언**하고 어댑터가 매핑한다. 시스템은 읽기 전용 실행 뒤 worktree 변경 여부(`git status`)를 확인해, 변경이 있으면 실행을 무효 처리한다.
3. **역할 프롬프트와 repo 지침은 도구 중립적으로** 쓴다. repo 지침의 기준 문서는 `AGENTS.md` 이고 `CLAUDE.md` 는 그것을 참조만 한다.
4. **transcript 는 원본과 정규화본을 함께 저장**한다. 정규화 이벤트: text, tool_call, tool_result, end.

### 세션 선택
| 상황 | 세션 |
|---|---|
| 질문, 수정 요청, 실행 중 개입 후 재개 (같은 Step, 같은 역할) | resume 우선 |
| 다음 Step | 새 세션 |
| Reviewer | 항상 새 세션 (검증 독립성) |
| Planner | 새 세션 (Ledger 기반 판단) |

- resume 은 최적화(캐시)다. 세션 기록은 그 머신의 로컬에 있으므로 다른 머신, 만료, 백엔드 변경, 컨텍스트 초과 시 실패한다. 실패하면 Context 패킷으로 새 세션을 띄우고, 어느 경로였는지 기록한다.
- 새 세션 경로가 쓸 만하도록 Worker 는 **작업 노트**(주요 판단과 이유, 버린 방법, 미확인 사항)를 산출물과 함께 남긴다.
- 새 세션이 질문에 답한 경우 "작업 기록을 바탕으로 재구성한 답변" 임을 표시한다.

## 이유
일회용 세션 원칙과 "메시지는 먼저 이벤트로 기록" 원칙 덕분에 능력 차이를 대체 경로로 흡수할 수 있다. Worker 와 Reviewer 를 서로 다른 모델로 돌리면 같은 맹점을 공유하지 않아 검증 독립성이 올라간다. 실행 기록에 백엔드를 남기면 회고에서 백엔드별·경로별(resume vs 새 세션) 재작업률을 비교할 수 있다.

## 포기한 대안
- Claude Agent SDK 에 직접 의존: 편하지만 단일 벤더에 묶인다.
- resume 전면 금지: 질문 답변의 질이 떨어지고 수정 요청 비용이 커진다.
- resume 에 의존: 서버화·백엔드 교체·세션 만료 시 작업이 멈춘다.
