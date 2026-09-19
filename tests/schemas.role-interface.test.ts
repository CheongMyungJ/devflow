// 역할 세션 사이를 오가는 것의 스키마 (T-0003): GateResult 의 지적·annotations, Run 의 performer,
// packet_gaps, Step.inputs 의 참조 문법, Reviewer·Worker 출력 파일.
// 거부 테스트는 "유효한 base 에서 한 가지만 바꾼 것" 으로 하고, 오류가 기대한 위치에서 났는지도 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const schemaDir = join(import.meta.dirname, '..', 'schemas');
const load = (name: string) => JSON.parse(readFileSync(join(schemaDir, `${name}.schema.json`), 'utf8'));

function compile(name: string): ValidateFunction {
  const a = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(a);
  return a.compile(load(name));
}

/** 거부되었고, 오류 가운데 instancePath 가 prefix 로 시작하는 것이 있으며, 그 밖의 위치에서는 오류가 없다. */
function expectRejectedAt(validate: ValidateFunction, value: unknown, prefix: string) {
  expect(validate(value), JSON.stringify(value)).toBe(false);
  const paths = (validate.errors ?? []).map((e) => e.instancePath);
  expect(paths.length).toBeGreaterThan(0);
  for (const p of paths) expect(p.startsWith(prefix), `오류 위치 ${p} 가 ${prefix} 밖이다`).toBe(true);
}

describe('GateResult: 지적(comments)과 annotations', () => {
  const validate = compile('gate-result');
  const base = {
    id: 'G-001',
    task_id: 'T-0009',
    step_id: 'step-001',
    artifact_refs: ['artifact://T-0009/step-001/plan@v1'],
    verdict: 'pass',
    checks: [{ kind: 'semantic', name: 'q', result: 'pass', evidence: 'e' }],
    created_at: '2026-09-19T00:00:00Z',
  };
  const finding = { severity: 'risk', class: 'B', text: '미확인 케이스가 있다' };

  it('base 자체는 유효하다', () => {
    expect(validate(base)).toBe(true);
  });

  it('구조화된 지적이 통과한다 (severity × class 의 모든 값, 빈 배열 포함)', () => {
    expect(validate({ ...base, comments: [] })).toBe(true);
    for (const severity of ['defect', 'risk', 'note'])
      for (const cls of ['A', 'B', 'C']) expect(validate({ ...base, comments: [{ severity, class: cls, text: 't' }] }), `${severity}/${cls}`).toBe(true);
    expect(validate({ ...base, verdict: 'fail', comments: [{ severity: 'defect', class: 'A', text: 't' }, finding] })).toBe(true);
  });

  it('구조화된 지적의 잘못된 예를 거부한다', () => {
    const bad: unknown[] = [
      { ...finding, severity: 'critical' }, // 없는 severity 값
      { ...finding, severity: 'Risk' },
      { ...finding, class: 'D' }, // 없는 class 값
      { ...finding, class: 'a' },
      { severity: 'risk', text: 't' }, // class 누락
      { class: 'B', text: 't' }, // severity 누락
      { severity: 'risk', class: 'B' }, // text 누락
      { ...finding, text: '' },
      { ...finding, grade: 'B' }, // 정의되지 않은 필드
      { text: '[risk / B] 문장을 객체에 넣은 것' },
    ];
    for (const item of bad) expectRejectedAt(validate, { ...base, comments: [item] }, '/comments');
    // 유효한 지적 사이에 끼어 있어도 거부된다
    expectRejectedAt(validate, { ...base, comments: [finding, { severity: 'risk', text: 't' }, finding] }, '/comments');
  });

  it('옛 형식(문장 comments)이 통과한다', () => {
    const legacy = [
      '[risk / B] append 직후 mtime 이 그대로인 경우가 있다',
      '[결함 1: lock 없는 reader 의 TOCTOU] …',
      '[Task AC 판정] AC1 충족',
      '[시스템 기록 — Reviewer 의 판정이 아님] Worker 가 실측했다',
    ];
    expect(validate({ ...base, comments: legacy })).toBe(true);
  });

  it('옛 형식과 새 형식을 한 배열에 섞을 수 없다 — 문장이 새 형식의 Gate 로 새지 않는다', () => {
    expectRejectedAt(validate, { ...base, comments: [finding, '[risk / B] 문장'] }, '/comments');
    expectRejectedAt(validate, { ...base, comments: ['[risk / B] 문장', finding] }, '/comments');
    expectRejectedAt(validate, { ...base, comments: '문장 하나' }, '/comments');
    expectRejectedAt(validate, { ...base, comments: [['중첩']] }, '/comments');
  });

  it('annotations: Reviewer 가 아닌 출처의 정보를 출처와 함께 담는다', () => {
    // T-0001 의 G-003, G-005 에 "[시스템 기록 — …]" 문장으로 들어갔던 내용의 모양
    const annotations = [
      { source: 'worker', text: 'Gate 와 병행해 2.9 의 전제를 실측했다. I2 불성립: 863/2000.', ref: 'blob:T-0001/step-001/R-005.probe' },
      { source: 'system', text: 'R-009 의 작업 노트는 리뷰와 병행해 작성되어 Reviewer 의 Context 패킷에 들어가지 못했다.' },
    ];
    expect(validate({ ...base, comments: [finding], annotations })).toBe(true);
    expect(validate({ ...base, annotations: [] })).toBe(true);
  });

  it('annotations 의 잘못된 예를 거부한다', () => {
    expectRejectedAt(validate, { ...base, annotations: [{ source: 'reviewer', text: 't' }] }, '/annotations');
    expectRejectedAt(validate, { ...base, annotations: [{ text: 't' }] }, '/annotations');
    expectRejectedAt(validate, { ...base, annotations: [{ source: 'system' }] }, '/annotations');
    expectRejectedAt(validate, { ...base, annotations: [{ source: 'system', text: '' }] }, '/annotations');
    expectRejectedAt(validate, { ...base, annotations: ['[시스템 기록] 문장'] }, '/annotations');
    expectRejectedAt(validate, { ...base, annotations: [{ source: 'system', text: 't', severity: 'risk' }] }, '/annotations');
  });
});

describe('Run: performer 와 packet_gaps', () => {
  const validate = compile('run');
  const base = {
    id: 'R-001',
    task_id: 'T-0009',
    step_id: 'step-001',
    role: 'worker',
    access: 'write',
    backend: 'claude-code',
    session_path: 'new',
    status: 'completed',
    submitted_at: '2026-09-19T00:00:00Z',
  };

  it('base(옛 형식 — performer 도 packet_gaps 도 없음)는 유효하다', () => {
    expect(validate(base)).toBe(true);
  });

  it('performer 의 유효한 값이 통과하고 session_path 와 독립이다', () => {
    for (const performer of ['isolated_session', 'conversation_session'])
      for (const session_path of ['new', 'resumed', 'resume_failed_new']) expect(validate({ ...base, performer, session_path }), `${performer}/${session_path}`).toBe(true);
  });

  it('performer 의 잘못된 값을 거부한다', () => {
    for (const performer of ['new', 'resumed', 'conversation', 'isolated', '', null, true]) expectRejectedAt(validate, { ...base, performer }, '/performer');
  });

  it('packet_gaps: "부족한 것이 없음"(빈 배열)과 "있음" 이 통과한다', () => {
    expect(validate({ ...base, packet_gaps: [] })).toBe(true);
    expect(validate({ ...base, packet_gaps: ['기준 SHA 가 패킷에 없어 직접 얻어 기록했다'] })).toBe(true);
  });

  it('packet_gaps 의 잘못된 예를 거부한다', () => {
    for (const packet_gaps of ['없음', null, [''], [{ text: 't' }], [1]]) expectRejectedAt(validate, { ...base, packet_gaps }, '/packet_gaps');
  });
});

describe('Decision: packet_gaps', () => {
  const validate = compile('decision');
  const base = { id: 'D-001', task_id: 'T-0009', action: 'abort', rationale: 'r', created_at: '2026-09-19T00:00:00Z' };

  it('없음(옛 기록) / 빈 배열 / 항목 있음이 모두 통과한다', () => {
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, packet_gaps: [] })).toBe(true);
    expect(validate({ ...base, packet_gaps: ['Skill 카탈로그가 패킷에 없었다'] })).toBe(true);
  });

  it('잘못된 예를 거부한다', () => {
    for (const packet_gaps of ['없음', null, [''], [{ text: 't' }]]) expectRejectedAt(validate, { ...base, packet_gaps }, '/packet_gaps');
  });
});

describe('Reviewer·Worker 출력 파일', () => {
  const reviewer = compile('reviewer-output');
  const worker = compile('worker-output');
  const reviewerBase = {
    verdict: 'fail',
    checks: [{ kind: 'semantic', name: 'q', result: 'fail', evidence: 'e' }],
    done_when: [{ condition: 'c', met: false, evidence: 'e' }],
    comments: [{ severity: 'defect', class: 'A', text: 't' }],
    packet_gaps: [],
  };
  const workerBase = { summary: 's', packet_gaps: ['verify 의 명령이 서술이어서 실제 명령을 패킷에서 찾아야 했다'] };

  it('유효한 예가 통과한다 (packet_gaps 가 빈 배열인 것과 항목이 있는 것)', () => {
    expect(reviewer(reviewerBase)).toBe(true);
    expect(reviewer({ ...reviewerBase, verdict: 'pass', comments: [], packet_gaps: ['Feedback 이 패킷에 없었다'] })).toBe(true);
    expect(worker(workerBase)).toBe(true);
    expect(worker({ ...workerBase, packet_gaps: [], work_notes: '# 노트', live_instructions_summary: '없음' })).toBe(true);
  });

  it('packet_gaps 는 필수다 — 새 출력에서는 "보고하지 않음" 이 없다', () => {
    const { packet_gaps: _r, ...reviewerWithout } = reviewerBase;
    const { packet_gaps: _w, ...workerWithout } = workerBase;
    expect(reviewer(reviewerWithout)).toBe(false);
    expect(reviewer.errors?.map((e) => e.params.missingProperty)).toEqual(['packet_gaps']);
    expect(worker(workerWithout)).toBe(false);
    expect(worker.errors?.map((e) => e.params.missingProperty)).toEqual(['packet_gaps']);
  });

  it('Reviewer 출력은 옛 형식(문장 comments)과 잘못된 지적을 거부한다', () => {
    expectRejectedAt(reviewer, { ...reviewerBase, comments: ['[defect / A] 문장'] }, '/comments');
    expectRejectedAt(reviewer, { ...reviewerBase, comments: [{ severity: 'defect', text: 't' }] }, '/comments');
    expectRejectedAt(reviewer, { ...reviewerBase, comments: [{ severity: 'blocker', class: 'A', text: 't' }] }, '/comments');
  });

  it('Reviewer 출력에는 annotations 와 식별 필드의 자리가 없다', () => {
    expect(reviewer({ ...reviewerBase, annotations: [{ source: 'system', text: 't' }] })).toBe(false);
    expect(reviewer({ ...reviewerBase, id: 'G-001' })).toBe(false);
  });

  it('Reviewer 출력에 식별 필드를 채우면 GateResult 로 유효하다', () => {
    const { packet_gaps: _gaps, ...rest } = reviewerBase;
    const gate = { id: 'G-001', task_id: 'T-0009', step_id: 'step-001', artifact_refs: ['artifact://T-0009/step-001/plan@v1'], reviewer_run_id: 'R-002', created_at: '2026-09-19T00:00:00Z', ...rest };
    expect(compile('gate-result')(gate)).toBe(true);
  });

  it('여러 스키마에 되풀이된 정의가 서로 같다 (지적, checks, done_when, packet_gaps 의 모양)', () => {
    const gate = load('gate-result');
    const ro = load('reviewer-output');
    expect(ro.properties.comments.items).toEqual(gate.$defs.finding);
    expect(ro.properties.checks).toEqual(gate.properties.checks);
    expect(ro.properties.done_when).toEqual(gate.properties.done_when);
    expect(ro.properties.verdict).toEqual(gate.properties.verdict);
    const shape = (s: { type: string; items: unknown }) => ({ type: s.type, items: s.items });
    const runGaps = shape(load('run').properties.packet_gaps);
    for (const name of ['decision', 'reviewer-output', 'worker-output']) expect(shape(load(name).properties.packet_gaps), name).toEqual(runGaps);
  });
});

describe('Step.inputs 의 참조 문법', () => {
  const validate = compile('step');
  const base = {
    id: 'step-001',
    task_id: 'T-0009',
    goal: 'g',
    scope: {},
    inputs: [],
    outputs: [{ name: 'plan', type: 'document' }],
    done_when: ['d'],
    verify: { semantic: ['q'] },
    approval: 'required',
    status: 'defined',
  };
  const sha = 'c01a30018fa7f3d2bd1d1b3c25daaecc0900b1c9';

  it('base 자체는 유효하다', () => {
    expect(validate(base)).toBe(true);
  });

  it('허용 형태 여섯 가지와 옛 기록에 실제로 쓰인 값이 통과한다', () => {
    const valid = [
      'task.brief',
      'task.ledger',
      'artifact://T-0001/step-001/store-interface@v3', // 이름에 하이픈
      'artifact://T-0012/step-002/repro-report@v12',
      'artifact://T-0001/step-002/plan.md@v1',
      `code://devflow@${sha}`,
      `code://devflow-data@${sha}`, // 대상 repo 가 아닌 등록된 프로젝트
      `code://proj_x.y@${'a'.repeat(64)}`,
      'gate://T-0001/step-001/G-003',
      'blob:T-0001/step-001/R-005.probe',
      'blob:key',
    ];
    for (const ref of valid) expect(validate({ ...base, inputs: [ref] }), ref).toBe(true);
    expect(validate({ ...base, inputs: valid })).toBe(true);
  });

  it('문법에 맞지 않는 참조를 거부한다', () => {
    const invalid = [
      'artifact://T-0001/step-001/store-design', // 버전 없음
      'artifact://T-0001/step-001/store-design@v0',
      'artifact://T-0001/step-001/store-design@3',
      'artifact://T-0001/step-001/store-design@latest',
      'artifact://T-0001/store-design@v1', // step 없음
      'artifact://T-0001/step-001/a/b@v1',
      'artifact://T-0001/step-001/../x@v1',
      'code://devflow', // SHA 없음
      'code://devflow@',
      'code://devflow@main',
      'code://devflow@c01a300', // 줄인 SHA
      `code://devflow@${sha.toUpperCase()}`,
      `code://@${sha}`,
      `code://devflow/src@${sha}`,
      'gate://T-0001/step-001', // id 없음
      'gate://T-0001/G-003',
      'gate://T-0001/step-001/G-003@v1',
      'blob:',
      'blob:/abs/key',
      'blob:../x',
      'blob:a/../b',
      'blob:a//b',
      'blob:C:/data/x',
      'blob:a\\b',
      'C:\\git\\devflow\\docs\\x.md', // 로컬 경로
      'C:/git/devflow/docs/x.md',
      '/home/me/devflow/docs/x.md',
      './docs/x.md',
      'docs/design/store.md',
      '\\\\server\\share\\x',
      'file:///C:/git/x',
      'https://example.com/x',
      'task.brief ', // 앞뒤 공백, 다른 task.* 이름
      ' task.ledger',
      'task.notes',
      'Task.brief',
      '',
      `code://devflow@${sha}\nC:\\x`, // 줄바꿈 뒤에 덧붙인 것
    ];
    for (const ref of invalid) expectRejectedAt(validate, { ...base, inputs: [ref] }, '/inputs/0');
    expectRejectedAt(validate, { ...base, inputs: ['task.brief', 'C:\\x', 'task.ledger'] }, '/inputs/1');
    expectRejectedAt(validate, { ...base, inputs: [42] }, '/inputs/0');
  });
});
