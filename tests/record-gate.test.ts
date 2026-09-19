// scripts/record-gate.mjs (입구 — commands.recordGate)를 자식 프로세스로 실제로 실행한다 (T-0003 AC7 → T-0006 step-004 에서 새 입구로).
// 옛 record-gate 의 검증 1~5 의 거부는 그대로 남고(한 가지만 바꾼 출력), 이제 Gate 와 Reviewer Run 이 한 commit 이다.
// 데이터 디렉터리는 임시 디렉터리에 commands 로 준비한다(Task·Step·Worker 산출물·submitted 인 Reviewer Run). 입력 예시는 tests/fixtures/record-gate/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CommandContext, systemClock } from '../src/commands/index.js';
import { submitReviewer, workerRound } from './commands/round-helpers.js';
import { allText, containsPath, entryRunner, validateData } from './entry-helpers.js';
import { contentSnapshot, createSample, newStore, tempDataDir } from './store/helpers.js';
import { REPO_ROOT } from './store/paths.js';
import { event, step } from './store/records.js';

const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'record-gate');
const OUTPUT = readFileSync(join(FIXTURES, 'data', 'T-9001', 'steps', 'step-001', 'runs', 'R-002.output.json'), 'utf8');
const entry = entryRunner('record-gate');

type Json = Record<string, any>;
let dataDir: string;
let taskId: string;
let refs: string;

beforeEach(async () => {
  dataDir = tempDataDir();
  const store = newStore(dataDir);
  taskId = (await createSample(store)).id;
  await store.commit(taskId, { writes: [{ kind: 'step', value: step(taskId, 'step-001') }], events: [event('step.defined', { step_id: 'step-001' })] });
  const sys: CommandContext = { store, clock: systemClock, actor: 'system', systemSha: 'a'.repeat(40) };
  refs = (await workerRound(sys, taskId)).refs.join(',');
  await submitReviewer(sys, taskId); // R-002
});

const taskDir = () => join(dataDir, taskId);
const recordGate = (outputText = OUTPUT, ...extra: string[]) => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', 'R-002', refs, '--output', entry.file(outputText, 'R-002.output.json'), ...extra]);
const readYaml = (rel: string): Json => parse(readFileSync(join(taskDir(), rel), 'utf8'));
const readGate = () => readYaml('steps/step-001/gates/G-001.yaml');
const readRun = () => readYaml('steps/step-001/runs/R-002.yaml');
const edited = (edit: (out: Json) => void) => {
  const out = JSON.parse(OUTPUT) as Json;
  edit(out);
  return JSON.stringify(out, null, 2);
};

/** 거부: exit 1, 데이터 디렉터리가 한 바이트도 바뀌지 않았다, 출력에 기대한 위치·이유가 있다. */
function expectRejected(run: () => ReturnType<typeof recordGate>, expected: (string | RegExp)[], status = 1) {
  const before = contentSnapshot(dataDir);
  const r = run();
  expect(r.status, r.all).toBe(status);
  for (const e of expected) expect(r.stderr).toMatch(e);
  expect(contentSnapshot(dataDir)).toEqual(before);
}

describe('record-gate: Reviewer 출력을 Gate 로 옮긴다 (한 commit)', () => {
  it('fixture 의 출력 예시를 받아들인다 — Gate, Run(completed, packet_gaps), in_review, 이벤트의 commit_id, validate-data 0 failed, 입력 경로는 기록되지 않는다', () => {
    const r = recordGate();
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(/recorded G-001 on T-0001\/step-001 — verdict pass, 3 checks, 2 comments; R-002 completed; seq \d+\.\.\d+, commit [0-9a-f-]{36}/);
    const out = JSON.parse(OUTPUT) as Json;
    const gate = readGate();
    expect(gate).toEqual({ id: 'G-001', task_id: taskId, step_id: 'step-001', artifact_refs: refs.split(','), verdict: out.verdict, checks: out.checks, done_when: out.done_when, comments: out.comments, reviewer_run_id: 'R-002', created_at: expect.stringMatching(/Z$/) });
    expect(gate).not.toHaveProperty('packet_gaps');
    expect(readRun()).toMatchObject({ status: 'completed', packet_gaps: out.packet_gaps });
    expect(readYaml('steps/step-001/step.yaml').status).toBe('in_review');
    expect(readFileSync(join(taskDir(), 'steps', 'step-001', 'runs', 'R-002.output.json'), 'utf8')).toBe(OUTPUT);
    const events = readFileSync(join(taskDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json).slice(-3);
    expect(events.map((e) => e.type)).toEqual(['run.completed', 'gate.completed', 'step.status_changed']);
    expect(new Set(events.map((e) => e.commit_id)).size).toBe(1);
    const v = validateData(dataDir);
    expect(v.status, v.all).toBe(0);
    expect(v.stdout).toMatch(/ 0 failed/);
    expect(containsPath(allText(dataDir), entry.inputs)).toBe(false);
  });

  it('빈 comments 와 빈 packet_gaps 도 그대로 옮긴다([] = 부족 없음)', () => {
    const r = recordGate(edited((o) => ((o.comments = []), (o.packet_gaps = []))));
    expect(r.status, r.all).toBe(0);
    expect(readGate().comments).toEqual([]);
    expect(readRun().packet_gaps).toEqual([]);
  });

  it('class A 가 있고 verdict 가 fail 이면 받아들이고 Step 은 revising', () => {
    const r = recordGate(edited((o) => ((o.verdict = 'fail'), (o.comments[0].class = 'A'))));
    expect(r.status, r.all).toBe(0);
    expect(readYaml('steps/step-001/step.yaml').status).toBe('revising');
  });

  it('--deterministic 의 내용은 Gate 와 같은 commit 에 G-001.deterministic.md 로, --output-attempts 는 Run 에', () => {
    const r = recordGate(OUTPUT, '--deterministic', entry.file('# deterministic\ntypecheck pass\n', 'det.md'), '--output-attempts', '2');
    expect(r.status, r.all).toBe(0);
    expect(readFileSync(join(taskDir(), 'steps', 'step-001', 'gates', 'G-001.deterministic.md'), 'utf8')).toBe('# deterministic\ntypecheck pass\n');
    expect(readRun().output_attempts).toBe(2);
  });
});

describe('record-gate: 옛 검증 1~5 의 거부 — 유효한 예시에서 한 가지만 바꾼다', () => {
  const cases: { name: string; edit: (out: Json) => void; expected: (string | RegExp)[] }[] = [
    { name: '전부 문장인 comments (옛 형식)', edit: (o) => (o.comments = o.comments.map((c: Json) => `[${c.severity} / ${c.class}] ${c.text}`)), expected: ['reviewer-output.schema.json', 'output/comments/0: must be object'] },
    { name: '문장과 객체가 섞인 comments', edit: (o) => (o.comments[1] = '[note / C] 문장으로 쓴 지적'), expected: ['output/comments/1: must be object'] },
    { name: 'packet_gaps 누락', edit: (o) => delete o.packet_gaps, expected: ["must have required property 'packet_gaps'"] },
    { name: '없는 severity 값', edit: (o) => (o.comments[0].severity = 'major'), expected: ['output/comments/0/severity: must be equal to one of the allowed values'] },
    { name: 'class 누락', edit: (o) => delete o.comments[1].class, expected: ["output/comments/1: must have required property 'class'"] },
    { name: '정의되지 않은 최상위 필드 — annotations', edit: (o) => (o.annotations = [{ source: 'system', text: 'x' }]), expected: ['output: must NOT have additional properties'] },
    { name: '정의되지 않은 최상위 필드 — 식별 필드(id)', edit: (o) => (o.id = 'G-001'), expected: ['output: must NOT have additional properties'] },
    { name: '빈 문장이 든 packet_gaps', edit: (o) => o.packet_gaps.push(''), expected: [/output\/packet_gaps\/\d+: must NOT have fewer than 1 characters/] },
    { name: 'class A 인 지적이 있는데 verdict 가 pass', edit: (o) => (o.comments[1].class = 'A'), expected: ['verdict is pass', 'output/comments/1/class is A'] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expectRejected(() => recordGate(edited(c.edit)), ['rejected — 아무것도 기록하지 않았다', ...c.expected]);
      expect(recordGate().status).toBe(0); // 다른 이유로 거부된 것이 아니다 — 바꾸지 않은 예시는 같은 자리에서 받아들여진다
    });
  }

  it('출력 파일이 JSON 이 아니다', () => expectRejected(() => recordGate('verdict: pass\n'), ['output: JSON 이 아니다']));

  it('출력 파일이 없다', () => {
    expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', 'R-002', refs, '--output', join(entry.inputs, 'no-such.json')]), ['--output 을 읽지 못했다']);
  });

  it('Run 이 Reviewer 의 것이 아니다 (worker 의 R-001)', () => {
    expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', 'R-001', refs, '--output', entry.file(OUTPUT)]), ['R-001 는 worker 의 Run 이다']);
  });

  it('없는 Run', () => {
    expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', 'R-007', refs, '--output', entry.file(OUTPUT)]), ['R-007 가 없다']);
  });

  it('이미 기록한 Gate 를 다시 — Run 이 이미 completed 이고 Step 은 checking 이 아니다. 기존 Gate·Run 은 그대로', () => {
    expect(recordGate().status).toBe(0);
    expectRejected(() => recordGate(edited((o) => ((o.packet_gaps = []), (o.comments = [])))), ['R-002 는 이미 completed 다']);
  });

  it('G-NNN 모양이 아닌 gate id (G1, 파일 이름이 될 수 없는 것) 와 다음에 발급될 id 가 아닌 것', () => {
    for (const [gateId, reason] of [['G1', 'G-NNN 의 정규형이 아니다'], ['G-001/../../x', 'G-NNN 의 정규형이 아니다'], ['G-002', '다음에 발급될 Gate id 는 G-001 다']]) {
      expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', gateId!, 'R-002', refs, '--output', entry.file(OUTPUT)]), [reason!]);
    }
  });

  it('로컬 경로가 섞인 artifact 참조 (a,,C:\\x) 와 가장 새 버전이 아닌 것·없는 것', () => {
    const first = refs.split(',')[0]!;
    expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', 'R-002', `a,,C:\\x`, '--output', entry.file(OUTPUT)]), ['"a" 는 artifact://', '"" 는 artifact://', '"C:\\\\x" 는 artifact://']);
    expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', 'R-002', first.replace('@v1', '@v2'), '--output', entry.file(OUTPUT)]), ['@v2 가 없다']);
  });
});

describe('record-gate: --annotations (Reviewer 가 아닌 출처의 정보)', () => {
  const fixtureAnnotations = join(FIXTURES, 'annotations.json');

  it('주면 Gate 의 annotations 에 담기고(Reviewer 의 지적과 섞이지 않는다) blob G-001.annotations.json 으로도 남는다', () => {
    const r = recordGate(OUTPUT, '--annotations', fixtureAnnotations);
    expect(r.status, r.all).toBe(0);
    const annotations = JSON.parse(readFileSync(fixtureAnnotations, 'utf8'));
    expect(readGate().annotations).toEqual(annotations);
    expect(readGate().comments).toEqual(JSON.parse(OUTPUT).comments);
    expect(JSON.parse(readFileSync(join(taskDir(), 'steps', 'step-001', 'gates', 'G-001.annotations.json'), 'utf8'))).toEqual(annotations);
    expect(validateData(dataDir).status).toBe(0);
  });

  it('옵션은 위치 인자 앞에 두어도 되고 --annotations=<file> 로 써도 되며 YAML 파일도 받는다', () => {
    const file = entry.file('- source: system\n  text: "YAML 로 쓴 것: 콜론과 # 가 있다"\n', 'annotations.yaml');
    const r = entry.run('record-gate', [`--annotations=${file}`, dataDir, taskId, 'step-001', 'G-001', 'R-002', refs, '--output', entry.file(OUTPUT)]);
    expect(r.status, r.all).toBe(0);
    expect(readGate().annotations).toEqual([{ source: 'system', text: 'YAML 로 쓴 것: 콜론과 # 가 있다' }]);
  });

  const bad: { name: string; value: unknown; expected: string[] }[] = [
    { name: '없는 source', value: [{ source: 'reviewer', text: 'x' }], expected: ['gate-result.schema.json', '/annotations/0/source: must be equal to one of the allowed values'] },
    { name: 'text 누락', value: [{ source: 'system' }], expected: ["/annotations/0: must have required property 'text'"] },
    { name: '정의되지 않은 필드', value: [{ source: 'system', text: 'x', severity: 'risk' }], expected: ['/annotations/0: must NOT have additional properties'] },
    { name: '배열이 아님', value: { source: 'system', text: 'x' }, expected: ['annotations: 하나 이상의 배열이어야 한다'] },
    { name: '빈 배열', value: [], expected: ['annotations: 하나 이상의 배열이어야 한다'] },
  ];
  for (const c of bad) {
    it(`잘못된 값은 거부한다 — ${c.name}`, () => expectRejected(() => recordGate(OUTPUT, '--annotations', entry.file(JSON.stringify(c.value), 'a.json')), c.expected));
  }

  it('파일이 없으면 거부한다', () => expectRejected(() => recordGate(OUTPUT, '--annotations', join(entry.inputs, 'none.json')), ['--annotations 을 읽지 못했다']));
});

describe('record-gate: 호출 형태', () => {
  it('위치 인자가 모자라거나, 옛 <task-dir> 모양이거나, 모르는 옵션(시각을 주려는 --at 포함)이면 사용법을 출력하고 exit 2, 아무것도 쓰지 않는다', () => {
    const out = entry.file(OUTPUT);
    expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', '--output', out]), ['usage: record-gate'], 2);
    expectRejected(() => entry.run('record-gate', [taskDir(), 'step-001', 'G-001', 'R-002', refs, '--output', out]), ['옛 인자 모양'], 2);
    expectRejected(() => recordGate(OUTPUT, '--force'), ['모르는 옵션 --force'], 2);
    expectRejected(() => recordGate(OUTPUT, '--at', '2026-01-01T00:00:00Z'), ['모르는 옵션 --at'], 2);
    expectRejected(() => recordGate(OUTPUT, '--actor', 'human:x'), ['모르는 옵션 --actor'], 2);
    expectRejected(() => entry.run('record-gate', [dataDir, 'T-12', 'step-001', 'G-001', 'R-002', refs, '--output', out]), ['T-NNNN 모양이 아니다'], 2);
    expectRejected(() => entry.run('record-gate', [dataDir, taskId, 'step-001', 'G-001', 'R-002', refs]), ['--output 가 필요하다'], 2);
  });
});
