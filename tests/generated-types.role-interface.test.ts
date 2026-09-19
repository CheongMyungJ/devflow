// 생성 타입(npm run gen → src/types/generated/)이 T-0003 에서 바뀐 스키마의 값을 실제로 받을 수 있는가.
// 단언은 타입 수준이다 — 대입이 안 되면 `npm run typecheck`(tests/ 도 tsc 의 대상)가 실패한다.
// vitest 는 타입을 검사하지 않으므로 실행 시의 검사는 같은 값이 스키마도 통과하는지만 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { Decision, GateResult, ReviewerOutput, Run, Step, WorkerOutput } from '../src/types/generated/index.js';

const schemaDir = join(import.meta.dirname, '..', 'schemas');
function compile(name: string) {
  const a = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(a);
  return a.compile(JSON.parse(readFileSync(join(schemaDir, `${name}.schema.json`), 'utf8')));
}

const sha = '0123456789abcdef0123456789abcdef01234567';

describe('생성 타입: Step.inputs', () => {
  // 여섯 형태의 리터럴이 각각 대입된다.
  const literals: Step['inputs'] = [
    'task.brief',
    'task.ledger',
    'artifact://T-0009/step-001/store-interface@v3',
    `code://devflow-data@${sha}`,
    'gate://T-0009/step-001/G-003',
    'blob:T-0009/step-001/R-005.probe',
  ];
  // 실행 중에 조립한 일반 string 도 대입된다(패킷 조립, Step 제안의 이식이 쓰는 경로).
  const project: string = 'devflow';
  const assembled: string = `code://${project}@${sha}`;
  const fromStrings: Step['inputs'] = [assembled];
  const plain: string[] = literals;
  // 문자열이 아닌 것은 여전히 타입에서 막힌다.
  // @ts-expect-error inputs 의 항목은 문자열이다
  const notString: Step['inputs'] = [42];

  it('타입에 대입한 값이 스키마의 문법도 통과한다', () => {
    const validate = compile('step');
    // verify 는 타입을 붙이지 않고 검증할 때 더한다: 생성 타입의 Step.verify 는 T-0003 이전부터 배열을 받지 못한다
    // (verify 의 anyOf 가지가 타입 없는 속성이라 색인 서명 객체로 생성된다). inputs 와 별개의 문제이고 이 테스트의 대상이 아니다.
    const step: Omit<Step, 'verify'> = {
      id: 'step-001',
      task_id: 'T-0009',
      goal: 'g',
      scope: {},
      inputs: [...literals, ...fromStrings],
      outputs: [{ name: 'o', type: 'document' }],
      done_when: ['d'],
      approval: 'required',
      status: 'defined',
    };
    expect(validate({ ...step, verify: { semantic: ['q'] } }), JSON.stringify(validate.errors)).toBe(true);
    expect(plain).toHaveLength(6);
    expect(notString).toHaveLength(1);
  });

  it('타입은 문법을 강제하지 않는다 — 문법은 스키마 검증이 강제한다', () => {
    const validate = compile('step');
    const typedButInvalid: Step['inputs'] = ['artifact://T-0009/step-001/plan'];
    expect(validate({ id: 'step-001', task_id: 'T-0009', goal: 'g', scope: {}, inputs: typedButInvalid, outputs: [{ name: 'o', type: 'document' }], done_when: ['d'], verify: { semantic: ['q'] }, approval: 'required', status: 'defined' })).toBe(false);
  });
});

describe('생성 타입: T-0003 에서 바뀐 다른 스키마', () => {
  it('GateResult 의 comments(두 형식)와 annotations', () => {
    const validate = compile('gate-result');
    const base = {
      id: 'G-001',
      task_id: 'T-0009',
      step_id: 'step-001',
      artifact_refs: ['artifact://T-0009/step-001/plan@v1'],
      verdict: 'pass',
      checks: [{ kind: 'semantic', name: 'q', result: 'pass', evidence: 'e' }],
      created_at: '2026-09-19T00:00:00Z',
    } satisfies GateResult;
    const structured: GateResult = {
      ...base,
      comments: [{ severity: 'risk', class: 'B', text: 't' }],
      annotations: [
        { source: 'system', text: 't' },
        { source: 'worker', text: 't', ref: 'blob:T-0009/step-001/R-005.probe' },
      ],
    };
    const legacy: GateResult = { ...base, comments: ['[risk / B] 문장'] };
    // @ts-expect-error 없는 severity 값
    const badSeverity: GateResult = { ...base, comments: [{ severity: 'critical', class: 'B', text: 't' }] };
    // @ts-expect-error class 누락
    const noClass: GateResult = { ...base, comments: [{ severity: 'risk', text: 't' }] };
    expect(validate(structured), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(legacy)).toBe(true);
    expect(validate(badSeverity)).toBe(false);
    expect(validate(noClass)).toBe(false);
  });

  it('Run 의 performer 와 packet_gaps', () => {
    const fields: Pick<Run, 'performer' | 'packet_gaps'>[] = [
      { performer: 'isolated_session', packet_gaps: [] },
      { performer: 'conversation_session', packet_gaps: ['verify 의 실제 명령이 없었다'] },
      {},
    ];
    // @ts-expect-error session_path 의 값은 performer 의 값이 아니다
    const bad: Pick<Run, 'performer'> = { performer: 'resumed' };
    expect(fields).toHaveLength(3);
    expect(bad.performer).toBe('resumed');
  });

  it('Decision 의 packet_gaps', () => {
    const none: Pick<Decision, 'packet_gaps'> = { packet_gaps: [] };
    const some: Pick<Decision, 'packet_gaps'> = { packet_gaps: ['기준 SHA 가 없었다'] };
    const unreported: Pick<Decision, 'packet_gaps'> = {};
    expect([none, some, unreported]).toHaveLength(3);
  });

  it('Reviewer·Worker 출력', () => {
    const reviewer: ReviewerOutput = {
      verdict: 'fail',
      checks: [{ kind: 'semantic', name: 'q', result: 'fail', evidence: 'e' }],
      done_when: [{ condition: 'c', met: false, evidence: 'e' }],
      comments: [{ severity: 'defect', class: 'A', text: 't' }],
      packet_gaps: [],
    };
    const worker: WorkerOutput = { summary: 's', packet_gaps: ['g'] };
    // @ts-expect-error Reviewer 출력의 comments 는 문장을 받지 않는다
    const legacyComments: ReviewerOutput = { ...reviewer, comments: ['[risk / B] 문장'] };
    // @ts-expect-error packet_gaps 는 필수다
    const noGaps: WorkerOutput = { summary: 's' };
    expect(compile('reviewer-output')(reviewer)).toBe(true);
    expect(compile('worker-output')(worker)).toBe(true);
    expect(compile('reviewer-output')(legacyComments)).toBe(false);
    expect(compile('worker-output')(noGaps)).toBe(false);
  });
});
