// 파일 구현체가 데이터 디렉터리에서 Task·Step 디렉터리와 기록 파일을 가리는 이름 규칙 (docs/design/store.md 3.1, 3.11).
// 규칙은 여기 한 곳에 있다: layout.ts(Store)와 scripts/validate-data.mjs 가 이것을 import 한다. JavaScript 인 이유는 validate-data 가
// 빌드 없이 Node 로 돌기 때문이다(src/schema/registry.mjs 와 같은 방식). 선언은 names.d.mts.
// scripts/check-store-read.mjs 는 일부러 사본을 두고(Store 가 자기 규칙으로 자기를 확인하지 않게), 둘이 같은 판단을 하는지는
// tests/store/dir-rules.test.ts 가 대 본다.

/** Task 디렉터리: 데이터 디렉터리 바로 아래의 T-<4자리 이상>. Task 스키마의 id pattern 과 같다. 번호는 1번 그룹. */
export const TASK_DIR = /^T-(\d{4,})$/;

/** Step 디렉터리: Task 디렉터리의 steps/ 아래의 **디렉터리** 가운데 step-<숫자>. steps/ 의 일반 파일과 다른 이름의 디렉터리는 Step 이 아니다. */
export const STEP_DIR = /^step-\d+$/;

/** runs/·gates/·decisions/·feedback/ 에서 기록으로 읽는 파일 이름. 그 밖의 이름(blob, 메모)은 그 kind 가 아니다. ID 는 1번 그룹. */
export const RECORD_FILE = Object.freeze({
  decision: /^(D-\d+)\.yaml$/,
  feedback: /^(F-\d+)\.yaml$/,
  run: /^(R-\d+)\.yaml$/,
  gate_result: /^(G-\d+)\.yaml$/,
});

/** Artifact 버전의 meta: steps/<step>/artifacts/<name>/v<N>.meta.yaml. 버전은 1번 그룹. */
export const META_FILE = /^v(\d+)\.meta\.yaml$/;
