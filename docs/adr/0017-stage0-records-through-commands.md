# ADR-0017: 0단계의 기록을 Store 위의 command 로 쓰고, 운영 스크립트는 조립 지점을 거치는 얇은 입구로

- 상태: Accepted
- 날짜: 2026-09-19

## 상황
0단계(수동 운영)의 기록은 Orchestrator 대화 세션이 yaml 을 손으로 쓰고, Store 를 쓰지 않는 운영 스크립트(append-events, propose-step, record-gate)가 이벤트와 일부 엔티티를 남겼다. 손 기록의 실수(step.yaml 의 status 를 고치지 않은 진행, 추정한 시각, 깨진 이스케이프)가 되풀이되었고, Store(ADR-0011, ADR-0015)는 쓰는 곳이 없었으며 이벤트에 commit_id 가 없었다. 옛 record-gate 는 Run 만 고친 채 죽을 수 있었고 로컬 경로가 섞인 참조를 받았다(T-0006). 운영 스크립트는 빌드 없이 Node 22 로 돌아 TypeScript 인 Store·commands 를 직접 import 할 수 없다.

## 결정
1. **데이터 디렉터리의 모든 기록은 command 가 Store 의 commit 하나로 쓴다.** Task 발행(`createTask`)과 done(`completeTask`), Step 한 바퀴(`submitRun`, `completeRun`, `failRun`, `recordGate`, `recordDecision`, `defineStep`, `requestRevision`, `approveStep`, `addFeedback`), 짝이 되는 엔티티가 없는 이벤트(`appendEvents`). 시각(초 단위 UTC)·ID·status·actor·system_sha·commit_id 는 도구가 채우고 입력으로 받지 않는다. 거부는 모두 아무것도 쓰기 전이다(`RejectedInputError`). 읽고 판단한 뒤 `expectedLastSeq` 로 commit 한다(`commitAfterReading`). Ledger 는 command 가 쓰지 않는다.
2. **운영 스크립트(`scripts/*.mjs`)는 입구다.** 인자와 파일을 읽어 command 하나를 부른다. Store 의 파일 구현체를 여는 곳은 조립 지점 `scripts/lib/assemble.mjs` 하나(와 검증용 check-store-read)이고, 입구는 그것과 공용 모듈 `scripts/lib/cli.mjs`·`node:` 만 import 한다(`tests/architecture.test.ts`). 옛 npm 명령 이름(append-events, propose-step, record-gate, validate-data)은 그대로 두고 속만 바꿨다. 입구의 앞 인자는 `<data-dir> <task-id>` 다. 사람이 한 일의 입구는 `--actor human:<id>` 를 요구한다.
3. **입구의 빌드**: `src/` 를 `tsc --noCheck` 로 `node_modules/.cache/` 아래에 빌드하고, 소스·tsconfig·lock·로더의 내용 해시가 같으면 다시 쓴다(`scripts/lib/build.mjs`). 타입 검사는 `npm run typecheck` 의 일이다.
4. **Step status 의 허용 전이표는 코드 한 곳**(`src/commands/transitions.ts`)에 있고 status 를 바꾸는 command 는 모두 그것으로 판단한다. 문서의 표(commands.md 7절)와 같은지 테스트가 대 본다. **이벤트의 ref 는 정해진 문법만**(`src/store/refs.ts` 의 `isEventRef` — artifact 참조, Store 가 발급하는 ID 의 정규형, Task id) 받는다.
5. **역할 세션의 출력은 데이터 디렉터리 밖에서 받아 blob 으로 남긴다**(T-0006 F-001 1-가·2-가·3-가): worker-output·reviewer-output·Planner 출력·deterministic 결과를 command 가 읽어 원문을 blob 으로 쓰고, Run 의 packet_gaps 는 출력에서 도구가 옮긴다. 입구가 받은 로컬 경로는 기록에 들어가지 않는다.
6. **승인은 `--gate G-NNN` 으로 사람이 본 버전만**(F-001 (2)): 그 Gate 의 artifact_refs 가 outputs 이름마다 하나이고 각각이 지금도 그 이름의 가장 새 버전일 때만 그 버전들을 승인한다.
7. Store 의 내부 파일 이름(`.locks/`, `.pending-*`, `.rollbacks`)은 `src/store/file/names.mjs` 한 곳에 두고, 데이터 repo 의 `.gitignore` 가 그것을 가리는지는 git 테스트(사본)와 실제 checkout 대조 명령 `check-gitignore` 가 본다.

## 이유
- 1: 한 기록을 한 command 가 한 commit 으로 쓰면 step.yaml 의 status 와 status 를 정한 이벤트가 어긋날 수 없고, 반쯤 쓰인 기록(Run 만 고친 Gate)이 생기지 않는다. 도구가 시각을 채우면 추정한 시각이 없어진다. 서버(1단계)로 가도 같은 command 를 HTTP 뒤에 둔다(ADR-0005).
- 2: 입구가 파일 배치를 모르게 하면 파일 구현체를 DB 로 바꿀 때 입구가 바뀌지 않는다(AGENTS.md 1·2번). 이름을 유지해 0단계 절차 문서의 명령 이름이 그대로 산다.
- 3: 입구 한 번에 빌드 0.45 s, 캐시를 쓰면 0.27 s(step-001 실측). 파일 시각은 checkout·복사에서 틀리므로 내용으로 본다.
- 4: 전이 규칙이 command 마다 흩어지면 한 command 만 틀려도 표 밖의 전이가 기록된다. ref 의 거부 목록(드라이브 문자 등)은 새 경로 모양을 막지 못한다.
- 5·6: 역할 세션이 데이터 디렉터리에 직접 쓰면 스키마 검증 전의 파일이 기록이 된다(AGENTS.md 6·13번). 승인할 버전을 모르는 승인은 사람이 보지 않은 버전을 승인할 수 있다(AGENTS.md 8번).

## 포기한 대안
- 스크립트가 Store 파일 구현체를 직접 부르기(조립 지점 없이): 파일 위치 지식이 스크립트마다 퍼진다. 스크립트를 `.mjs` 로 다시 쓰고 규칙을 복사하기: 규칙의 사본이 생긴다.
- 입구를 `--experimental-transform-types` 로 빌드 없이 돌리기(Node 22.15 의 실험 기능), 매번 빌드하기(느리다), 빌드물을 commit 하기(생성물을 commit 하지 않는다), 파일 시각으로 캐시 판단하기.
- command 마다 허용 from 을 적기, 문서의 전이표를 실행 때 읽기(문서가 코드의 입력이 된다).
- 역할 세션이 최종 자리에 직접 쓰고 command 가 가리키기만 하기(6.4 의 예외로만 남겼고 구현하지 않았다), 승인 입구가 가장 새 버전을 스스로 고르기(사람이 본 버전과 다를 수 있다).
- 옛 입구를 그대로 두고 새 이름의 명령을 더하기: 같은 기록을 쓰는 길이 둘이 된다.
