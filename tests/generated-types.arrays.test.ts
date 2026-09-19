// 생성 타입(npm run gen → src/types/generated/)이 배열을 받는가 (T-0005 의 S1, AC2) — Step.verify, Task.acceptance_criteria,
// Decision.next_step.step. 그리고 decision 스키마가 next_step.step 을 Step 의 정의로 검사하는가 (AC10).
//
// 타입 수준의 단언은 `npm run typecheck`(tests/ 도 tsc 의 대상)에 걸린다 — 대입이 안 되거나 @ts-expect-error 가 발동하지 않으면
// typecheck 가 실패한다. vitest 는 타입을 검사하지 않으므로 실행 시에는 같은 값이 스키마를 통과하는지(또는 거부되는지)를 본다.
// 거부 테스트는 유효한 base 에서 한 가지만 바꾸고, 오류가 기대한 위치에서만 났는지 본다(다른 이유로 거부된 것을 통과로 세지 않는다).
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { loadSchemas } from '../src/schema/registry.mjs';
import type { Decision, Step, StepDefinition, Task } from '../src/types/generated/index.js';

const schemas = loadSchemas();
const validateStep = schemas.validator('step');
const validateTask = schemas.validator('task');
const validateDecision = schemas.validator('decision');

/** 거부되었고, 모든 오류의 instancePath 가 prefix 로 시작한다. 오류의 (위치 keyword) 목록을 돌려준다. */
function rejectedAt(validate: ValidateFunction, value: unknown, prefix: string): string[] {
  expect(validate(value), JSON.stringify(value)).toBe(false);
  const errors = validate.errors ?? [];
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) expect(e.instancePath.startsWith(prefix), `오류 위치 ${e.instancePath} (${e.keyword}) 가 ${prefix} 밖이다`).toBe(true);
  return [...new Set(errors.map((e) => `${e.instancePath} ${e.keyword}`))].sort();
}

// ---- 실행 중에 조립한, 길이를 모르는 배열 ----
/** 타입이 T[] 인 배열(튜플이 아니다). 실행 중에 조립한 배열이 이 타입이다. */
const list = <T>(...items: T[]): T[] => items;
const questions: string[] = list('q1', 'q2');
const checks: { name: string; run: string }[] = list({ name: 'typecheck', run: '@typecheck' }, { name: 'test', run: '@test' });
const acItems: { id: string; text: string; covers?: string[] }[] = list({ id: 'AC1', text: 'a', covers: ['S1'] }, { id: 'AC2', text: 'b' });
const acTexts: string[] = list('a', 'b', 'c');

/** Step 의 정의(id·task_id·status 없음). 타입을 붙여 만든다. */
const definition: StepDefinition = {
  skill: null,
  goal: 'g',
  scope: { include: ['src/'], exclude: ['docs/'] },
  inputs: ['task.brief', 'artifact://T-0009/step-001/plan@v1'],
  outputs: [{ name: 'o', type: 'document' }],
  done_when: ['d'],
  verify: { semantic: ['q'] },
  approval: 'required',
  rationale: 'r',
};
const stepIds = { id: 'step-002', task_id: 'T-0009', status: 'defined' } as const;

describe('생성 타입: Step.verify 가 배열을 받는다 (AC2)', () => {
  const semanticOnly: Step['verify'] = { semantic: ['q'] };
  const deterministicOnly: Step['verify'] = { deterministic: [{ name: 'test', run: '@test' }] };
  const both: Step['verify'] = { deterministic: [{ name: 'test', run: '@test', expect: 'failure' }], semantic: ['q1', 'q2'] };
  // 길이를 모르는 배열
  const fromArrays: Step['verify'] = { deterministic: checks, semantic: questions };
  const semanticFromArray: Step['verify'] = { semantic: questions };
  // @ts-expect-error verify 는 deterministic 과 semantic 중 하나는 있어야 한다
  const empty: Step['verify'] = {};
  // @ts-expect-error semantic 의 항목은 문자열이다
  const numberQuestion: Step['verify'] = { semantic: [1] };
  // @ts-expect-error deterministic 의 항목에는 run 이 있다
  const noRun: Step['verify'] = { deterministic: [{ name: 'test' }] };

  it('타입을 붙인 Step 이 스키마를 통과한다 — semantic 만 / deterministic 만 / 둘 다', () => {
    for (const verify of [semanticOnly, deterministicOnly, both]) {
      const step: Step = { ...definition, ...stepIds, verify };
      expect(validateStep(step), JSON.stringify(validateStep.errors)).toBe(true);
    }
    // 길이를 모르는 배열로 채운 verify
    for (const verify of [fromArrays, semanticFromArray]) {
      const step: Step = { ...definition, ...stepIds, verify };
      expect(validateStep(step), JSON.stringify(validateStep.errors)).toBe(true);
    }
  });

  it('verify 가 둘 다 비었으면 여전히 스키마에서 거부된다 (ADR-0003)', () => {
    for (const verify of [{}, { semantic: [] }, { deterministic: [] }, { deterministic: [], semantic: [] }])
      expect(rejectedAt(validateStep, { ...definition, ...stepIds, verify }, '/verify')).not.toEqual([]);
    // 한쪽이 비고 다른 쪽이 있으면 통과한다(기준 스키마와 같다)
    expect(validateStep({ ...definition, ...stepIds, verify: { deterministic: [], semantic: ['q'] } })).toBe(true);
    // 타입에서 막힌 값은 스키마에서도 거부된다
    expect(validateStep({ ...definition, ...stepIds, verify: empty })).toBe(false);
    expect(validateStep({ ...definition, ...stepIds, verify: numberQuestion })).toBe(false);
    expect(validateStep({ ...definition, ...stepIds, verify: noRun })).toBe(false);
  });

  it('Step 의 기존 거부는 그대로다 — 정의되지 않은 필드, id·task_id·status 없음, 빈 outputs·done_when', () => {
    const step: Step = { ...definition, ...stepIds };
    expect(validateStep(step)).toBe(true);
    expect(rejectedAt(validateStep, { ...step, extra: 1 }, '')).toEqual([' unevaluatedProperties']);
    for (const key of ['id', 'task_id', 'status', 'goal', 'verify', 'approval'] as const) {
      const { [key]: _omit, ...rest } = step;
      expect(rejectedAt(validateStep, rest, ''), key).toEqual([' required']);
    }
    expect(rejectedAt(validateStep, { ...step, id: 'step-1' }, '/id')).toEqual(['/id pattern']);
    expect(rejectedAt(validateStep, { ...step, outputs: [] }, '/outputs')).toEqual(['/outputs minItems']);
    expect(rejectedAt(validateStep, { ...step, done_when: [] }, '/done_when')).toEqual(['/done_when minItems']);
  });
});

describe('생성 타입: Task.acceptance_criteria 가 길이를 모르는 배열을 받는다 (AC2)', () => {
  const base = {
    id: 'T-0009',
    title: 't',
    type: 'feature',
    goal: 'g',
    background: 'b',
    constraints: [],
    target: { repo: 'devflow', base_branch: 'main', task_branch: 'task/T-0009' },
    status: 'open',
    created_at: '2026-09-19T00:00:00Z',
  } satisfies Omit<Task, 'acceptance_criteria'>;
  const fromItems: Task = { ...base, acceptance_criteria: acItems };
  const fromMap: Task = { ...base, acceptance_criteria: acTexts.map((text, i) => ({ id: `AC${i + 1}`, text })) };
  // @ts-expect-error AC 는 식별자가 있는 객체다
  const bare: Task = { ...base, acceptance_criteria: ['a'] };

  it('실행 중에 조립한 배열로 채운 Task 가 스키마를 통과한다', () => {
    for (const task of [fromItems, fromMap]) expect(validateTask(task), JSON.stringify(validateTask.errors)).toBe(true);
    expect(fromMap.acceptance_criteria).toHaveLength(3);
  });

  it('acceptance_criteria 가 비었거나 없으면 여전히 스키마에서 거부된다', () => {
    expect(rejectedAt(validateTask, { ...base, acceptance_criteria: [] }, '/acceptance_criteria')).toEqual(['/acceptance_criteria minItems']);
    expect(rejectedAt(validateTask, base, '')).toEqual([' required']);
    expect(validateTask(bare)).toBe(false);
  });
});

describe('Decision.next_step.step 은 Step 의 정의다 (AC2, AC10)', () => {
  const base = { id: 'D-001', task_id: 'T-0009', action: 'next_step', rationale: 'r', created_at: '2026-09-19T00:00:00Z' } as const;
  const withStep: Decision = { ...base, next_step: { step: definition } };
  const withSkill: Decision = { ...base, next_step: { skill: 'bugfix@1', params: { x: 1 } } };
  // 길이를 모르는 배열로 채운 정의도 대입된다
  const assembled: Decision = { ...base, next_step: { step: { ...definition, done_when: questions, verify: { semantic: questions } } } };
  // 읽는 쪽: next_step.step 이 Step 의 정의로 나온다(뭉개진 {} 가 아니다)
  const goal: string | undefined = withStep.next_step?.step?.goal;
  const verify: Step['verify'] | undefined = withStep.next_step?.step?.verify;

  // @ts-expect-error inputs 는 서술 문장이 아니라 참조의 배열이다
  const sentenceInputs: Decision = { ...base, next_step: { step: { ...definition, inputs: 'step-001 의 산출물' } } };
  // @ts-expect-error outputs 는 문자열이 아니라 객체의 배열이다
  const stringOutputs: Decision = { ...base, next_step: { step: { ...definition, outputs: 'plan.md' } } };
  // @ts-expect-error 정의되지 않은 필드
  const extraField: Decision = { ...base, next_step: { step: { ...definition, owner: 'me' } } };
  // @ts-expect-error next_step.step 에는 id 가 없다 — Step 을 만들 때 시스템이 붙인다
  const withId: Decision = { ...base, next_step: { step: { ...definition, id: 'step-002' } } };

  it('올바른 next_step 이 통과한다 (Freeform 의 step, Skill)', () => {
    for (const d of [withStep, withSkill]) expect(validateDecision(d), JSON.stringify(validateDecision.errors)).toBe(true);
    // 기존 Decision 이 쓰는 모양: skill: null, scope 의 include/exclude, 여섯 형태의 inputs, deterministic 과 semantic
    const full: Decision = {
      ...base,
      next_step: {
        step: {
          ...definition,
          inputs: ['task.brief', 'task.ledger', 'artifact://T-0009/step-001/plan@v1', `code://devflow@${'a'.repeat(40)}`, 'gate://T-0009/step-001/G-001', 'blob:T-0009/step-001/R-002.work-notes'],
          outputs: [{ name: 'change', type: 'code_change', description: 'd' }, { name: 'notes', type: 'document' }],
          verify: { deterministic: [{ name: 'test', run: '@test' }], semantic: ['q'] },
          approval: 'optional',
          created_from: 'D-001',
        },
      },
    };
    expect(validateDecision(full), JSON.stringify(validateDecision.errors)).toBe(true);
    expect(validateDecision(assembled), JSON.stringify(validateDecision.errors)).toBe(true);
    expect(goal).toBe('g');
    expect(verify).toEqual({ semantic: ['q'] });
  });

  it('틀린 모양의 next_step.step 을 거부한다 — 오류는 /next_step/step 안에서만 난다', () => {
    const bad: [string, unknown][] = [
      ['서술 문장인 inputs', sentenceInputs.next_step?.step],
      ['항목이 서술 문장인 inputs', { ...definition, inputs: ['step-001 의 산출물'] }],
      ['문자열인 outputs', stringOutputs.next_step?.step],
      ['정의되지 않은 필드', extraField.next_step?.step],
      ['id', withId.next_step?.step],
      ['task_id', { ...definition, task_id: 'T-0009' }],
      ['status', { ...definition, status: 'defined' }],
      ['빈 verify', { ...definition, verify: {} }],
      ['goal 없음', (({ goal: _g, ...rest }) => rest)(definition)],
      ['빈 outputs', { ...definition, outputs: [] }],
      ['객체가 아닌 step', 'step 을 문장으로'],
    ];
    for (const [label, step] of bad) {
      const errors = rejectedAt(validateDecision, { ...base, next_step: { step } }, '/next_step');
      expect(errors.some((e) => e.startsWith('/next_step/step')), `${label}: ${errors.join(', ')}`).toBe(true);
    }
  });

  it('정의되지 않은 필드·id·status 는 unevaluatedProperties 로 거부된다', () => {
    for (const extra of [{ owner: 'me' }, { id: 'step-002' }, { status: 'defined' }])
      expect(rejectedAt(validateDecision, { ...base, next_step: { step: { ...definition, ...extra } } }, '/next_step/step')).toEqual(['/next_step/step unevaluatedProperties']);
  });

  it('next_step 의 다른 규칙은 그대로다 — step 과 skill 중 정확히 하나, action=next_step 이면 next_step 필수', () => {
    expect(validateDecision({ ...base, next_step: { step: definition, skill: 'bugfix@1' } })).toBe(false);
    expect(validateDecision({ ...base, next_step: {} })).toBe(false);
    expect(validateDecision({ ...base, next_step: { params: {} } })).toBe(false);
    expect(validateDecision(base)).toBe(false);
  });
});
