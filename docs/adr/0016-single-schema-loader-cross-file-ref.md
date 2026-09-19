# ADR-0016: 스키마를 파일을 가로질러 `$ref` 하고, 스키마 로더를 하나로

- 상태: Accepted
- 날짜: 2026-09-19

## 상황
생성 타입이 배열을 받지 못했다(Step.verify, Task.acceptance_criteria 의 튜플, Decision.next_step). 또 Decision 의 `next_step.step` 은 안쪽이 검사되지 않아 틀린 모양의 Step 제안이 통과했다. 둘을 고치려면 step 스키마의 정의를 decision 스키마가 참조해야 했는데, 그때까지 ajv 로더는 validator.ts, validate-data, record-gate, 테스트 곳곳에 따로 있었고 스키마를 하나씩 컴파일했다(T-0005 step-001 의 실험에서 파일을 가로지르는 참조를 풀지 못해 테스트가 실패했다). 운영 스크립트는 빌드 없이 Node(22.15)로 돌아 TypeScript 를 import 할 수 없다.

## 결정
1. **스키마가 파일을 가로질러 `$ref` 한다.** step 스키마의 정의(id·task_id·status 를 뺀 것)를 `$defs/definition`(생성 타입 `StepDefinition`)으로 빼고, Step 과 Decision 의 `next_step.step` 이 같은 정의를 `allOf` + `unevaluatedProperties: false` 로 참조한다. verify 의 anyOf 가지에 `type: array` 를 두고, 타입 생성은 `ignoreMinAndMaxItems` 와 이름을 적은 export 로 한다(스키마와 생성기를 둘 다 고치는 길).
2. **스키마 로더는 `src/schema/registry.mjs`(+ `registry.d.mts`) 하나다.** `schemas/` 의 스키마를 모두 한 ajv 에 등록한 뒤 이름으로 검증 함수를 꺼낸다. Store(`validator.ts` 를 거쳐), `scripts/validate-data.mjs`, `scripts/record-gate.mjs`, 테스트가 모두 이것을 쓴다. 새 로더를 만들지 않는다.
3. 로더를 JavaScript 로 두는 대가로, `src/` 를 tsc 로 빌드해 실행하는 곳은 `src/**/*.mjs` 를 빌드 출력으로 함께 옮긴다(`docs/architecture.md` 2.1).

## 이유
- 1: 한 정의를 두 곳이 참조하므로 step 스키마에 필드를 더하면 두 쪽에 함께 반영된다(복사한 모양이 어긋나는 일이 없다). `unevaluatedProperties` 여야 `allOf` 로 들어온 속성을 알아본다. 기준 스키마가 거부하던 값은 모두 여전히 거부되고 새로 거부되는 것은 `next_step.step` 의 틀린 모양뿐임을 나란히 대 보아 확인했다 — 검증이 느슨해지지 않았다.
- 2: 파일을 가로지르는 참조는 모든 스키마를 등록한 로더에서만 풀린다. 로더가 여럿이면 한쪽만 고쳐질 위험이 그대로다. JavaScript 에 두면 스크립트는 빌드 없이, TypeScript 는 선언 파일로 같은 코드를 쓴다.

## 포기한 대안
- 스키마만 고치기(`minItems: 1` 을 `contains: {}` 로): 생성기의 한계 때문에 스키마를 덜 읽기 쉬운 표현으로 바꾸고, 새 필수 배열마다 같은 함정이 있다. 중복 export 때문에 생성기도 결국 고쳐야 한다.
- 생성기만 고치기(전처리): `next_step.step` 의 검사는 스키마를 바꾸지 않고는 할 수 없고, 전처리의 판별이 휴리스틱이다.
- `next_step.step` 에 Step 의 모양을 복사해 두기: 이중 정의가 된다.
- tsconfig 의 `allowJs`, 실행 시 동적 import 로 로더 찾기, 스크립트를 `--experimental-strip-types` 로 돌리기(Node 22.15 에서 실험 기능), 로더를 파일마다 두고 "모두 등록" 규칙만 맞추기.
