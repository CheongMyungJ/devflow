// Task 안의 ID 와 artifact 참조의 문법 (docs/design/store.md 3.1). 인터페이스의 일부이고 파일 위치는 모른다 — blob-ref.ts 와 같은 자리다.
// Store 의 파일 구현체(src/store/file/layout.ts)와 commands 가 같은 함수를 쓴다. 사본을 두지 않는다.
// 같은 모양이 schemas/ 의 pattern 에도 있다(task·step 의 id, step 의 artifact:// 참조).

import type { IssuedIdKind } from './types.js';

/**
 * Task id 의 모양: T-<4자리 이상>(Task 스키마의 id pattern 과 같다). 이 모양의 기준은 여기 한 곳이다 — ARTIFACT_REF 도 이것으로 만들고,
 * 입구는 command 쪽에서 isTaskId 를 받아 쓴다(scripts/ 에 사본을 두지 않는다). 파일 구현체의 Task 디렉터리 규칙(src/store/file/names.mjs 의
 * TASK_DIR)과 같은 판단인지는 tests/store/refs.test.ts 가 같은 이름 목록으로 대 본다.
 */
const TASK_ID = String.raw`T-\d{4,}`;
const TASK_ID_ONLY = new RegExp(`^${TASK_ID}$`);
export const isTaskId = (id: string): boolean => TASK_ID_ONLY.test(id);

const PREFIX: Record<IssuedIdKind, string> = { step: 'step', decision: 'D', feedback: 'F', run: 'R', gate_result: 'G' };

/** 읽을 때 받는 모양: <접두어>-<숫자>. 번호를 돌려준다. 아니면 undefined. */
export function idNumber(kind: IssuedIdKind, id: string): number | undefined {
  const match = new RegExp(`^${PREFIX[kind]}-(\\d+)$`).exec(id);
  return match ? Number(match[1]) : undefined;
}

/** 쓸 때 요구하는 모양(정규형): 3자리 0 채움, 999 를 넘으면 자릿수가 늘어난다('R-012', 'R-1000'). 'R-12', 'R-0012', 'R-000' 은 아니다. */
export function isCanonicalId(kind: IssuedIdKind, id: string): boolean {
  const n = idNumber(kind, id);
  return n !== undefined && n >= 1 && formatId(kind, n) === id;
}

export function formatId(kind: IssuedIdKind, n: number): string {
  return `${PREFIX[kind]}-${String(n).padStart(3, '0')}`;
}

/** Gate id 의 정규형 G-NNN 인가. 'G1', 'g-001', 'G-0012', 'G-001.yaml', 경로가 섞인 것은 아니다. */
export const isGateId = (id: string): boolean => isCanonicalId('gate_result', id);

/** Artifact 의 이름: 영숫자로 시작하고 영숫자·.·_·- 만 (step 스키마의 artifact:// pattern 과 같다). */
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isArtifactName = (name: string): boolean => ARTIFACT_NAME.test(name);

/**
 * artifact://<task>/<step>/<name>@v<N>. 조각마다 모양이 정해져 있어 드라이브 문자(`C:`), 역슬래시, 빈 조각, `..` 같은 경로 조각은
 * 어느 자리에도 들어갈 수 없다. N 은 1 이상이고 앞에 0 이 없다.
 */
const ARTIFACT_REF = new RegExp(String.raw`^artifact://(${TASK_ID})/(step-\d+)/([A-Za-z0-9][A-Za-z0-9._-]*)@v([1-9]\d*)$`);

export interface ParsedArtifactRef {
  taskId: string;
  stepId: string;
  name: string;
  version: number;
}

export function artifactRef(taskId: string, stepId: string, name: string, version: number): string {
  return `artifact://${taskId}/${stepId}/${name}@v${version}`;
}

/** 참조를 나눈다. 문법에 맞지 않으면 undefined. */
export function parseArtifactRef(ref: string): ParsedArtifactRef | undefined {
  const m = ARTIFACT_REF.exec(ref);
  return m ? { taskId: m[1]!, stepId: m[2]!, name: m[3]!, version: Number(m[4]) } : undefined;
}

/** 이벤트의 ref 로 받는 ID 의 kind — Store 가 발급하는 ID 전부. */
const EVENT_REF_ID_KINDS: readonly IssuedIdKind[] = ['step', 'decision', 'feedback', 'gate_result', 'run'];

/**
 * 이벤트의 ref 로 받는 모양인가(T-0006 F-003, docs/design/commands.md 6.3). 받는 것은 셋뿐이다 —
 * artifact 참조(parseArtifactRef 가 나누는 것), Store 가 발급하는 ID 의 정규형(step-NNN, D-NNN, F-NNN, G-NNN, R-NNN — isCanonicalId),
 * Task id(isTaskId). 드라이브 문자·역슬래시·슬래시가 든 경로, 비정규 id('G1', 'R-12'), 빈 문자열, 앞뒤 공백은 어느 것에도 맞지 않는다.
 * 모양만 본다 — 가리키는 것이 있는지는 부르는 쪽이 본다. appendEvents 의 입력과 command 가 채운 ref 가 모두 이 함수를 지난다.
 */
export function isEventRef(ref: string): boolean {
  return parseArtifactRef(ref) !== undefined || isTaskId(ref) || EVENT_REF_ID_KINDS.some((kind) => isCanonicalId(kind, ref));
}
