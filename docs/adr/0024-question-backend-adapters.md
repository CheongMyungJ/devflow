# ADR-0024: 질문 CLI의 backend별 대화형 어댑터

- 상태: Accepted
- 날짜: 2026-09-20

## 배경

ADR-0023의 question 설정은 세 CLI backend를 선택할 수 있지만 실제 인계 구현은 Codex에만 있었다. 사용자는 Claude Code와 OpenCode도 선택해 실행하도록 요청했다. OpenCode는 설치되어 있지 않으며, 사용자의 명시적 지시로 공식 가이드에 따라 구현하고 검증하지 않는다.

## 결정

- `Runner.openQuestion`을 Codex·Claude Code·OpenCode 각각 구현한다. 공통 스냅샷 준비와 Windows 콘솔 인계는 `runner/local/question`에 두고 native 인자·권한·설정 지식은 각 어댑터에 둔다.
- 질문의 설정 계층·사건·HITL 상태 전이는 바꾸지 않는다. CLI 인계 뒤 즉시 복귀하며 대화·종료·답변을 관리하지 않는다. resume를 사용하지 않는다.
- Codex는 기존 0.154.0의 read-only sandbox 계약을 유지한다. Claude Code는 설치된 2.1.278의 대화형 safe-mode/restricted, 읽기 도구만 허용, dontAsk, MCP/확장 제한을 사용한다. 관리형 실행과 모델/effort 검사를 공유한다.
- OpenCode는 공식 **1.x** 가이드의 TUI, `--pure`, 전용 primary agent, 기본 deny와 read/glob/grep allow, 외부 디렉터리 deny를 조립한다. 기본 작업 agent는 비활성화한다. `run` 전용 variant 옵션을 TUI에 사용하지 않는다. 질문 reasoning은 가이드에 명시된 `openai/...` 모델의 agent `reasoningEffort`에 연결하고 다른 provider에서는 reasoning을 생략하도록 안내한다. 이는 관리형 OpenCode의 reasoning 지원을 바꾸지 않는다.
- native 설정 위치는 질문마다 새로 만들고 기존 설정·세션·인증 파일을 복사하지 않는다. native 창에서 인증이 필요할 수 있다. OpenCode의 home/config/data 경로 재지정과 플러그인 제한도 문서 기반 구현이며 완전한 환경 격리나 실제 쓰기 차단을 검증했다고 주장하지 않는다. 관리자 정책은 유지한다.

## 검증과 한계

공통/Codex/Claude 계약 및 기존 흐름 회귀를 검사한다. OpenCode 이름의 기존 어댑터 테스트도 이번 실행에서는 제외하며 새 OpenCode 실행 테스트를 추가하지 않는다. TypeScript 빌드에는 모든 소스가 포함되지만 OpenCode 설치·CLI 실행·모델 호출·권한 동작 검증은 하지 않는다. 설치된 Claude CLI의 옵션 확인과 대역 계약은 실제 모델 질문 대화 검증과 구분한다.

## 근거

- [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude 설정 디렉터리](https://code.claude.com/docs/en/claude-directory)
- [OpenCode CLI](https://opencode.ai/docs/cli/), [설정](https://opencode.ai/docs/config/), [권한](https://opencode.ai/docs/permissions/), [agent 및 reasoningEffort](https://opencode.ai/docs/agents/)

2026-09-20 공식 1.x 가이드를 기준으로 삼는다. 별도 V2 문서의 `agents`/`permissions` 형식과 혼합하지 않는다. 다른 버전의 호환성 및 실제 질문 모델 대화는 후속 검증 범위다.
