// Task 양식의 의도의 칸(T-0004): problem, success_criteria, affected, non_goals, open_questions 와 AC 의 covers.
// (1) 스키마의 유효·무효 예 (2) 생성 타입(npm run gen → src/types/generated/)이 그 값을 실제로 받는가.
// 타입 수준의 단언은 `npm run typecheck`(tests/ 도 tsc 의 대상)에 걸린다 — vitest 는 타입을 검사하지 않는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/types/generated/index.js';

const a = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(a);
const validate = a.compile(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schemas', 'task.schema.json'), 'utf8')));
const errors = () => JSON.stringify(validate.errors);
/** 거부된 이유가 의도한 자리인지 본다 — 다른 이유(빠진 필수 필드 등)로 거부된 것을 통과로 세지 않는다. */
const rejectedOnlyAt = (value: unknown): string[] => {
  expect(validate(value)).toBe(false);
  return [...new Set((validate.errors ?? []).map((e) => `${e.instancePath} ${e.keyword}`))].sort();
};

/** 새 칸이 하나도 없는 옛 양식의 Task. T-0001~T-0004 의 기록이 이 모양이다. */
const legacy = {
  id: 'T-0009',
  title: 't',
  type: 'other',
  goal: 'g',
  background: '[문제] 옛 양식에서는 문제가 배경에 섞여 있다',
  constraints: ['c', '범위 밖 — 옛 양식에서는 여기에 끼워 넣었다', '맡긴 것 — 옛 양식에서는 여기에 끼워 넣었다'],
  acceptance_criteria: [{ id: 'AC1', text: 'a' }],
  target: { repo: 'devflow', base_branch: 'main', task_branch: 'task/T-0009' },
  status: 'open',
  created_at: '2026-09-19T00:00:00Z',
} satisfies Task;

/** 새 칸을 모두 채운 Task. 타입을 붙여 만든다 — 대입이 안 되면 typecheck 가 실패한다. */
const full: Task = {
  ...legacy,
  background: '출처와 경과',
  constraints: ['기존 기록을 수정하지 않는다'],
  problem: '완성된 정의를 통째로 확인받아 의도가 어긋났는지 찾기 어렵다',
  success_criteria: [
    { id: 'S1', text: '의도 초안을 먼저 확인받는다' },
    { id: 'S2', text: '정의 파일을 열면 범위 밖이 제 칸에 있다' },
  ],
  affected: ['사람 — Intake 를 받는 방식이 바뀐다', '옛 기록 — 새 양식으로 다시 검사된다'],
  non_goals: ['Intake 를 돕는 CLI'],
  open_questions: [
    { id: 'Q1', text: '새 칸을 필수로 할지 선택으로 할지', answered_by: 'planner_or_worker' },
    { id: 'Q2', text: '새 칸이 생성 타입에서 쓸 수 있게 나오는가', answered_by: 'investigation_step' },
  ],
  acceptance_criteria: [
    { id: 'AC1', text: 'typecheck 와 test 가 통과한다', covers: [] }, // 어느 성공 기준도 옮기지 않은 AC (전체의 바닥)
    { id: 'AC2', text: 'intake.md 가 두 단계를 지시한다', covers: ['S1'] },
    { id: 'AC3', text: '실험에서 첫 응답이 의도 초안이다', covers: ['S1'] }, // 한 성공 기준을 옮긴 두 번째 AC
    { id: 'AC4', text: '양식에 자리가 있고 예가 통과한다', covers: ['S1', 'S2'] }, // 한 AC 가 여러 성공 기준을
    { id: 'AC5', text: '실행 중 추가된 요구사항', added_by: 'F-001' }, // 대응을 적지 않은 AC
  ],
};

describe('Task 스키마: 의도의 칸', () => {
  it('새 칸이 하나도 없는 옛 양식이 통과한다', () => {
    expect(validate(legacy), errors()).toBe(true);
  });

  it('새 칸을 모두 채운 예가 통과한다 — 대응 없는 AC(covers: []), 한 성공 기준을 옮긴 여러 AC, covers 없는 AC 를 포함한다', () => {
    expect(validate(full), errors()).toBe(true);
    expect(full.acceptance_criteria.filter((ac) => ac.covers?.includes('S1'))).toHaveLength(3);
  });

  it('새 칸은 서로 독립된 선택 필드다 — 일부만 있어도, 빈 배열("없다고 확인했다")이어도 통과한다', () => {
    expect(validate({ ...legacy, problem: 'p' }), errors()).toBe(true);
    expect(validate({ ...legacy, non_goals: ['n'] }), errors()).toBe(true);
    expect(validate({ ...legacy, success_criteria: [], affected: [], non_goals: [], open_questions: [] }), errors()).toBe(true);
  });

  it("'사람이 답함' 이 남은 열린 질문은 거부된다 — 담당자의 값만 다른 같은 Task 정의로 비교한다", () => {
    const withOwner = (answered_by: string) => ({ ...full, open_questions: [{ id: 'Q1', text: 'q', answered_by }] });
    expect(validate(withOwner('planner_or_worker')), errors()).toBe(true);
    expect(validate(withOwner('investigation_step')), errors()).toBe(true);
    expect(rejectedOnlyAt(withOwner('human'))).toEqual(['/open_questions/0/answered_by enum']);
    // 여럿 가운데 하나만 남아 있어도 거부된다
    const mixed = { ...full, open_questions: [...full.open_questions!, { id: 'Q3', text: 'q', answered_by: 'human' }] };
    expect(rejectedOnlyAt(mixed)).toEqual(['/open_questions/2/answered_by enum']);
  });

  it('열린 질문: 담당자가 없는 것, 없는 담당자 값, 모양이 틀린 것은 거부된다', () => {
    expect(rejectedOnlyAt({ ...full, open_questions: [{ id: 'Q1', text: 'q' }] })).toEqual(['/open_questions/0 required']);
    expect(rejectedOnlyAt({ ...full, open_questions: [{ id: 'Q1', text: 'q', answered_by: 'reviewer' }] })).toEqual(['/open_questions/0/answered_by enum']);
    expect(rejectedOnlyAt({ ...full, open_questions: [{ id: 'Q1', text: 'q', answered_by: null }] })).toEqual(['/open_questions/0/answered_by enum']);
    expect(rejectedOnlyAt({ ...full, open_questions: ['문장만 적은 질문'] })).toEqual(['/open_questions/0 type']);
    expect(rejectedOnlyAt({ ...full, open_questions: [{ text: 'q', answered_by: 'planner_or_worker' }] })).toEqual(['/open_questions/0 required']);
    expect(rejectedOnlyAt({ ...full, open_questions: [{ id: '1', text: 'q', answered_by: 'planner_or_worker' }] })).toEqual(['/open_questions/0/id pattern']);
    expect(rejectedOnlyAt({ ...full, open_questions: [{ id: 'Q1', text: 'q', answered_by: 'planner_or_worker', answer: 'x' }] })).toEqual(['/open_questions/0 additionalProperties']);
  });

  it('다른 새 칸: 모양이 틀린 것은 거부된다', () => {
    expect(rejectedOnlyAt({ ...full, problem: ['문장의 배열'] })).toEqual(['/problem type']);
    expect(rejectedOnlyAt({ ...full, problem: '' })).toEqual(['/problem minLength']);
    expect(rejectedOnlyAt({ ...full, success_criteria: ['식별자 없는 문장'] })).toEqual(['/success_criteria/0 type']);
    expect(rejectedOnlyAt({ ...full, success_criteria: [{ id: 'AC1', text: 's' }] })).toEqual(['/success_criteria/0/id pattern']);
    expect(rejectedOnlyAt({ ...full, success_criteria: [{ id: 'S1' }] })).toEqual(['/success_criteria/0 required']);
    expect(rejectedOnlyAt({ ...full, affected: '사람' })).toEqual(['/affected type']);
    expect(rejectedOnlyAt({ ...full, affected: [{ who: '사람' }] })).toEqual(['/affected/0 type']);
    expect(rejectedOnlyAt({ ...full, non_goals: [1] })).toEqual(['/non_goals/0 type']);
    expect(rejectedOnlyAt({ ...full, non_goals: '없음' })).toEqual(['/non_goals type']);
  });

  it('AC 의 covers: 성공 기준의 id 모양만 받는다. 가리킨 id 가 실제로 있는지는 스키마가 검사하지 않는다(한계)', () => {
    const withCovers = (covers: unknown) => ({ ...full, acceptance_criteria: [{ id: 'AC1', text: 'a', covers }] });
    expect(rejectedOnlyAt(withCovers('S1'))).toEqual(['/acceptance_criteria/0/covers type']);
    expect(rejectedOnlyAt(withCovers(['AC2']))).toEqual(['/acceptance_criteria/0/covers/0 pattern']);
    expect(rejectedOnlyAt(withCovers(['S1', 'S1']))).toEqual(['/acceptance_criteria/0/covers uniqueItems']);
    expect(validate(withCovers(['S99'])), errors()).toBe(true); // 없는 성공 기준을 가리켜도 통과한다 — description 에 적힌 한계
  });

  it('옛 양식의 허용이 새 칸의 검사를 느슨하게 하지 않는다 — 옛 양식의 Task 에 틀린 새 칸을 더하면 거부된다', () => {
    expect(rejectedOnlyAt({ ...legacy, open_questions: [{ id: 'Q1', text: 'q', answered_by: 'human' }] })).toEqual(['/open_questions/0/answered_by enum']);
    expect(rejectedOnlyAt({ ...legacy, out_of_scope: ['이름이 다른 칸'] })).toEqual([' additionalProperties']);
  });
});

describe('생성 타입: 의도의 칸', () => {
  it('길이를 모르는 일반 배열을 새 칸에 대입할 수 있다', () => {
    const strings: string[] = ['a', 'b'].filter((s) => s !== 'b');
    const criteria: { id: string; text: string }[] = strings.map((text, i) => ({ id: `S${i + 1}`, text }));
    const owner: 'planner_or_worker' | 'investigation_step' = strings.length > 1 ? 'planner_or_worker' : 'investigation_step';
    const questions: { id: string; text: string; answered_by: typeof owner }[] = strings.map((text, i) => ({ id: `Q${i + 1}`, text, answered_by: owner }));
    const assembled: Task = {
      ...legacy,
      affected: strings,
      non_goals: strings,
      success_criteria: criteria,
      open_questions: questions,
      acceptance_criteria: [{ id: 'AC1', text: 'a', covers: criteria.map((c) => c.id) }],
    };
    expect(validate(assembled), errors()).toBe(true);
  });

  it('새 칸이 구체적인 타입이다 — 뭉개졌다면(unknown, 색인 서명 객체) 아래의 대입과 @ts-expect-error 가 typecheck 에서 실패한다', () => {
    // 읽는 쪽: 구체적인 타입으로 나온다
    const problem: string | undefined = full.problem;
    const firstCriterion: string | undefined = full.success_criteria?.[0]?.id;
    const affected: string[] | undefined = full.affected;
    const owner: 'planner_or_worker' | 'investigation_step' | undefined = full.open_questions?.[0]?.answered_by;
    const covers: string[] | undefined = full.acceptance_criteria[0].covers;
    expect([problem, firstCriterion, affected, owner, covers]).toHaveLength(5);

    // 쓰는 쪽: 틀린 모양은 타입에서 막힌다
    // @ts-expect-error 사람을 뜻하는 담당자 값은 타입에도 없다
    const human: Task['open_questions'] = [{ id: 'Q1', text: 'q', answered_by: 'human' }];
    // @ts-expect-error 담당자는 필수다
    const noOwner: Task['open_questions'] = [{ id: 'Q1', text: 'q' }];
    // @ts-expect-error 열린 질문은 문장이 아니라 객체다
    const sentence: Task['open_questions'] = ['q'];
    // @ts-expect-error 성공 기준은 식별자가 있는 객체다
    const bareCriterion: Task['success_criteria'] = ['s'];
    // @ts-expect-error 성공 기준에 없는 속성
    const extraProp: Task['success_criteria'] = [{ id: 'S1', text: 's', acs: ['AC1'] }];
    // @ts-expect-error 영향받는 것은 문자열의 배열이다
    const affectedObjects: Task['affected'] = [{ who: '사람' }];
    // @ts-expect-error 범위 밖은 배열이다
    const nonGoalsString: Task['non_goals'] = '없음';
    // @ts-expect-error 문제는 문자열이다
    const problemArray: Task['problem'] = ['p'];
    // @ts-expect-error covers 는 id 의 배열이다
    const coversString: Task['acceptance_criteria'] = [{ id: 'AC1', text: 'a', covers: 'S1' }];

    // 타입이 막은 값은 스키마도 거부한다
    for (const bad of [{ open_questions: human }, { open_questions: noOwner }, { open_questions: sentence }, { success_criteria: bareCriterion }, { success_criteria: extraProp }, { affected: affectedObjects }, { non_goals: nonGoalsString }, { problem: problemArray }, { acceptance_criteria: coversString }]) {
      expect(validate({ ...legacy, ...bad }), JSON.stringify(bad)).toBe(false);
    }
  });
});
