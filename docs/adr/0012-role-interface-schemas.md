# ADR-0012: 역할 출력의 스키마, packet_gaps 의 자리, 옛 형식 기록과의 공존

- 상태: Accepted
- 날짜: 2026-09-19

## 상황
T-0001, T-0002 를 손으로 운영하면서 역할 세션(Planner, Worker, Reviewer)이 주고받는 것 가운데 스키마에 자리가 없는 것이 드러났다: Reviewer 의 지적의 등급, Reviewer 가 아닌 출처의 정보, Run 의 수행 주체, 패킷의 부족함에 대한 보고(packet_gaps), `step.inputs` 의 문법. Worker 와 Reviewer 의 출력 파일에는 스키마가 없었다. 한편 이미 기록된 Gate·Run·Decision 은 고치지 않는다(이벤트와 같은 이유 — 기록은 그때의 사실이다). `validate-data` 는 모든 기록을 지금의 스키마로 검사한다.

## 결정
1. **역할 세션의 출력 파일마다 스키마를 둔다.** Planner 는 `decision.schema.json`(출력이 곧 Decision), Reviewer 는 `reviewer-output.schema.json`, Worker 는 `worker-output.schema.json`. 출력 스키마는 현재 형식만 받는다.
2. **packet_gaps 의 기록 자리는 Run 이다.** 역할 세션은 자기 출력 파일의 최상위 `packet_gaps`(문장의 배열, 없으면 빈 배열)에 적고, 시스템이 그 Run 의 `packet_gaps` 로 옮긴다. 필드가 없으면 "보고하지 않음" 이다.
3. **Reviewer 가 아닌 출처의 정보는 GateResult 의 `annotations`(source: system | worker)에 둔다.** Reviewer 의 출력에는 그 자리가 없다.
4. **기록 스키마가 바뀌어도 옛 기록은 고치지 않고, 옛 형식의 허용은 그 스키마 안에 둔다.** 허용은 형식에 대한 것이지 특정 Task 나 시점에 대한 것이 아니며, description 이 옛 형식임을 밝힌다. `validate-data` 에 Task·파일을 건너뛰는 예외를 두지 않는다. 새 필드는 선택 필드로 더하고, 모양이 바뀐 필드는 "배열 전체가 새 형식이거나 전체가 옛 형식" 처럼 섞이지 않는 합집합으로 받는다. 새로 쓰는 기록이 옛 형식으로 돌아가는 것은 결정 1 의 출력 스키마가 막는다.
5. **`step.inputs` 의 `code://<project>@<sha>` 는 대상 repo 가 아닌 등록된 프로젝트를 가리켜도 된다.** 읽기 전용 참조이며 "Task 하나는 repo 하나, worktree 하나"(ADR-0008)는 쓰기에 대한 규칙으로 그대로다. 참조 문법(여섯 형태, 줄이지 않은 SHA)은 Step 스키마가 강제한다.

## 이유
- 1: 아키텍처의 전제가 "(Context 패킷) → (스키마로 검증되는 출력)" 인데 두 역할은 검증할 스키마가 없었다. 기록 스키마는 옛 형식도 읽어야 하므로 느슨해질 수밖에 없고, 엄격함을 둘 곳이 따로 필요하다.
- 2: packet_gaps 는 산출물이 아니라 "그 실행이 받은 패킷" 에 대한 보고이고, 세 역할 모두가 갖는 기록은 Run 뿐이다. Worker 에게는 Decision·GateResult 같은 출력 엔티티가 없다.
- 3: comments 에 문장으로 섞으면 누구의 판단인지가 관례에 달린다.
- 4: 이 결정을 내린 Task(T-0003) 자신의 기록도 옛 형식으로 쓰이고 뒤에 새 스키마로 검사된다. Task ID 나 날짜에 묶은 예외는 그때마다 틀린다.
- 5: 시스템 repo 와 데이터 repo 처럼 한 Task 가 두 repo 의 상태를 함께 읽어야 하는 일이 T-0002 부터 실제로 있었다. 읽기는 Task 간 간섭을 만들지 않는다.

## 포기한 대안
- 옛 기록을 새 형식으로 옮겨 쓰기: 기록을 고치게 되고, "[결함 1: …]" 처럼 틀에 맞지 않는 문장은 등급을 지어내야 한다.
- 스키마에 버전을 두고 기록마다 버전을 적기: 옛 기록에는 버전 필드가 없어 결국 "없으면 옛 것" 이라는 같은 규칙이 되고, 검사기에 분기가 생긴다.
- 구조화된 지적을 새 필드(`findings`)로 두고 `comments` 를 옛 필드로 남기기: 새 Gate 가 두 필드를 다 쓸 수 있어 "지적은 어디에 있는가" 가 둘이 된다.
- packet_gaps 를 엔티티마다(Decision, GateResult, …) 두기: Worker 의 자리가 없고, 패킷의 부족함을 역할을 가로질러 모으려면 세 곳을 읽어야 한다.
