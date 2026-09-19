// artifact 참조와 Task 안의 ID(gate id 포함)의 문법 (src/store/refs.ts — 파일 구현체 밖, commands 가 import 할 수 있는 자리).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_DIR } from '../../src/store/file/names.mjs';
import { artifactRef, formatId, idNumber, isArtifactName, isCanonicalId, isEventRef, isGateId, isTaskId, parseArtifactRef } from '../../src/store/refs.js';
import { REPO_ROOT } from './paths.js';

describe('artifact 참조의 문법', () => {
  it('artifact://<task>/<step>/<name>@v<N> 를 나누고, 만든 참조는 다시 같은 값으로 나뉜다', () => {
    expect(parseArtifactRef('artifact://T-0006/step-001/commands-design@v1')).toEqual({ taskId: 'T-0006', stepId: 'step-001', name: 'commands-design', version: 1 });
    expect(parseArtifactRef('artifact://T-12345/step-012/a.b_c-d@v10')).toEqual({ taskId: 'T-12345', stepId: 'step-012', name: 'a.b_c-d', version: 10 });
    const ref = artifactRef('T-0006', 'step-002', 'work-notes', 3);
    expect(ref).toBe('artifact://T-0006/step-002/work-notes@v3');
    expect(parseArtifactRef(ref)).toEqual({ taskId: 'T-0006', stepId: 'step-002', name: 'work-notes', version: 3 });
  });

  it.each([
    // 로컬 경로 — 드라이브 문자, 역슬래시, 절대 경로, 상대 경로
    'C:\\x',
    'D:/data/T-0006/plan/v1.meta.yaml',
    'artifact://C:\\x',
    'artifact://T-0006/step-001/C:\\x@v1',
    'artifact://T-0006/step-001/C:@v1',
    'artifact://T-0006\\step-001\\plan@v1',
    'artifact://T-0006/step-001/plan\\@v1',
    '/home/me/plan.md',
    './plan@v1',
    'artifact://T-0006/step-001/../plan@v1',
    'artifact://T-0006/step-001/..@v1',
    'artifact://T-0006/step-001/sub/plan@v1',
    'file:///C:/x',
    // 빈 조각
    'artifact:///step-001/plan@v1',
    'artifact://T-0006//plan@v1',
    'artifact://T-0006/step-001/@v1',
    'artifact://T-0006/step-001/plan@v',
    '',
    // 그 밖의 모양
    'artifact://T-0006/step-001/plan',
    'artifact://T-0006/step-001/plan@v0',
    'artifact://T-0006/step-001/plan@v01',
    'artifact://T-06/step-001/plan@v1',
    'artifact://t-0006/step-001/plan@v1',
    'artifact://T-0006/Step-001/plan@v1',
    'artifact://T-0006/step-001/.plan@v1',
    'artifact://T-0006/step-001/plan@v1 ',
    ' artifact://T-0006/step-001/plan@v1',
    'artifact://T-0006/step-001/plan@v1\n',
    'artifact://T-0006/step-001/plan@v1,artifact://T-0006/step-001/x@v1',
    'ARTIFACT://T-0006/step-001/plan@v1',
    'blob:T-0006/step-001/R-002.work-notes',
  ])('참조가 아니다: %j', (ref) => {
    expect(parseArtifactRef(ref)).toBeUndefined();
  });

  it('Artifact 이름은 영숫자로 시작하고 영숫자·.·_·- 만', () => {
    expect(['plan', 'work-notes', 'a.b', 'A_1'].every(isArtifactName)).toBe(true);
    expect(['', '.plan', '..', '-x', 'a/b', 'a\\b', 'C:', 'a b'].some(isArtifactName)).toBe(false);
  });
});

describe('gate id 와 Task 안의 ID 의 모양', () => {
  it.each(['G-001', 'G-009', 'G-999', 'G-1000', 'G-12345'])('정규형 gate id: %s', (id) => {
    expect(isGateId(id)).toBe(true);
  });

  it.each(['G1', 'G-1', 'G-01', 'G-0012', 'G-000', 'g-001', 'G-001 ', 'G-001.yaml', 'G-001/x', 'G-001\\x', 'C:\\G-001', '../G-001', 'R-001', 'G-', 'G--001', 'G-00a', ''])(
    '정규형 gate id 가 아니다: %j',
    (id) => {
      expect(isGateId(id)).toBe(false);
    },
  );

  it('읽을 때는 <접두어>-<숫자>, 쓸 때는 3자리 0 채움', () => {
    expect(idNumber('run', 'R-12')).toBe(12);
    expect(idNumber('run', 'R-x')).toBeUndefined();
    expect(isCanonicalId('run', 'R-012')).toBe(true);
    expect(isCanonicalId('run', 'R-12')).toBe(false);
    expect(isCanonicalId('step', 'step-001')).toBe(true);
    expect(formatId('gate_result', 7)).toBe('G-007');
    expect(formatId('decision', 1234)).toBe('D-1234');
  });

  it('문법은 한 곳에 있다 — layout.ts 에 참조·ID 의 정규식 사본이 없다', () => {
    const layout = readFileSync(join(REPO_ROOT, 'src', 'store', 'file', 'layout.ts'), 'utf8');
    expect(layout).not.toMatch(/artifact:\\\/\\\//);
    expect(layout).not.toMatch(/PREFIX|padStart/);
    expect(layout).toContain("from '../refs.js'");
  });
});

// T-0006 step-004 (G-002 B): Task id 의 모양은 refs.ts 한 곳. 파일 구현체의 Task 디렉터리 규칙과 같은 판단이다.
describe('Task id 의 모양', () => {
  const NAMES = ['T-0001', 'T-0006', 'T-1234', 'T-12345', 'T-012', 'T-12', 'T-1', 'T-', 't-0001', 'T-0001 ', ' T-0001', 'T-0001\n', 'T-00a1', 'T0001', 'T-0001/x', '../T-0001', 'C:\\T-0001', 'T-0001.yaml', 'X-0001', ''];

  it.each(NAMES)('isTaskId 와 names.mjs 의 TASK_DIR 이 같게 판단한다: %j', (name) => {
    expect(isTaskId(name)).toBe(TASK_DIR.test(name));
  });

  it('받는 것과 받지 않는 것이 둘 다 목록에 있다(대조가 한쪽으로 쏠리지 않았다)', () => {
    expect(NAMES.filter(isTaskId)).toEqual(['T-0001', 'T-0006', 'T-1234', 'T-12345']);
  });

  it('refs.ts 안에서도 한 곳 — ARTIFACT_REF 는 TASK_ID 로 만든다(T-\d{4,} 의 사본이 없다)', () => {
    const refs = readFileSync(join(REPO_ROOT, 'src', 'store', 'refs.ts'), 'utf8');
    expect(refs.match(/T-\\d\{4,\}/g)).toHaveLength(1);
    expect(parseArtifactRef('artifact://T-012/step-001/plan@v1')).toBeUndefined();
  });

  it('scripts/ 에 Task id 정규식의 사본이 없다 — 입구는 commands.isTaskId 를 쓴다', () => {
    const dir = join(REPO_ROOT, 'scripts');
    const offenders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.mjs') && !name.includes('check-store-read'))
      .filter((name) => /T-\\d/.test(readFileSync(join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// T-0006 F-003: 이벤트의 ref 로 받는 모양 — appendEvents 의 입력과 command 가 채운 ref 가 모두 이 함수를 지난다.
describe('이벤트 ref 의 문법 (isEventRef)', () => {
  it.each([
    // 옛 기록이 쓰는 네 모양
    'artifact://T-0005/step-001/store-design@v1',
    'D-001',
    'F-012',
    'G-002',
    // 이 Task 가 새로 쓰게 되는 ID
    'R-009',
    'step-004',
    'R-1000',
    'T-0006',
  ])('받는다: %s', (ref) => {
    expect(isEventRef(ref)).toBe(true);
  });

  it.each([
    'C:\\x',
    'C:/x',
    'D:/data/T-0006/plan.md',
    '\\\\server\\share',
    '\\x',
    '/home/me/x',
    './R-001',
    'runs/R-001.yaml',
    'T-0006/step-001',
    'artifact://T-0006/step-001/C:\\x@v1',
    'G1',
    'G-1',
    'G-0012',
    'R-12',
    'step-1',
    'step-0001',
    'D-000',
    'T-12',
    '',
    ' G-001',
    'G-001 ',
    'G-001\n',
    'x',
    'blob:T-0006/step-001/R-002.work-notes',
    'gate://T-0006/step-001/G-001',
  ])('받지 않는다: %j', (ref) => {
    expect(isEventRef(ref)).toBe(false);
  });

  it('옛 기록(fixture 와 같은 모양)의 ref 는 네 모양뿐이라 모두 받는다', () => {
    const olds = ['artifact://T-0001/step-001/plan@v2', 'D-003', 'F-007', 'G-004'];
    expect(olds.every(isEventRef)).toBe(true);
  });
});
