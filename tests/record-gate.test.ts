// scripts/record-gate.mjs 를 자식 프로세스로 실제로 실행해 검사한다(T-0003 의 AC7).
// 입력 예시는 tests/fixtures/record-gate/ 에 있다 — data/ 는 그대로 데이터 디렉터리의 모양이라,
// 임시 디렉터리에 복사한 뒤 같은 명령을 손으로 돌려 재현할 수 있다.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './store/paths.js';

const RECORD_GATE = join(REPO_ROOT, 'scripts', 'record-gate.mjs');
const VALIDATE_DATA = join(REPO_ROOT, 'scripts', 'validate-data.mjs');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'record-gate');

const TASK = 'T-9001';
const STEP = 'step-001';
const GATE = 'G-001';
const RUN = 'R-002';
const REFS = 'artifact://T-9001/step-001/example-doc@v1,artifact://T-9001/step-001/work-notes@v1';

type Json = Record<string, any>;

let tmp: string;
let dataDir: string;
const taskDir = () => join(dataDir, TASK);
const gateFile = () => join(taskDir(), 'steps', STEP, 'gates', `${GATE}.yaml`);
const runFile = () => join(taskDir(), 'steps', STEP, 'runs', `${RUN}.yaml`);
const outFile = () => join(taskDir(), 'steps', STEP, 'runs', `${RUN}.output.json`);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'devflow-record-gate-'));
  dataDir = join(tmp, 'data');
  cpSync(join(FIXTURES, 'data'), dataDir, { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function node(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
const recordGate = (...extra: string[]) => node(RECORD_GATE, [taskDir(), STEP, GATE, RUN, REFS, ...extra]);
const validateData = () => node(VALIDATE_DATA, [dataDir]);

const readOutput = (): Json => JSON.parse(readFileSync(outFile(), 'utf8'));
const writeOutput = (value: unknown) => writeFileSync(outFile(), JSON.stringify(value, null, 2));
const editOutput = (edit: (out: Json) => void) => {
  const out = readOutput();
  edit(out);
  writeOutput(out);
};
const readGate = (): Json => parse(readFileSync(gateFile(), 'utf8'));
const readRun = (): Json => parse(readFileSync(runFile(), 'utf8'));
const writeAnnotations = (value: unknown, name = 'annotations.json') => {
  const file = join(tmp, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};

/** 거부: exit 1, Gate 파일 없음, Run 기록이 글자 그대로. 출력에 기대한 위치·이유가 있다. */
function expectRejected(r: ReturnType<typeof node>, runBefore: string, expectedInOutput: (string | RegExp)[]) {
  expect(r.status, r.all).toBe(1);
  for (const e of expectedInOutput) expect(r.stderr).toEqual(expect.stringMatching(e instanceof RegExp ? e : new RegExp(escapeRegExp(e))));
  expect(existsSync(gateFile())).toBe(false);
  expect(existsSync(join(taskDir(), 'steps', STEP, 'gates'))).toBe(false);
  expect(readFileSync(runFile(), 'utf8')).toBe(runBefore);
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('record-gate: 새 형식의 Reviewer 출력을 Gate 로 옮긴다', () => {
  it('fixture 의 출력 예시는 그대로 받아들여지고, 기록된 데이터 디렉터리가 validate-data 를 0 failed 로 통과한다', () => {
    const before = validateData();
    expect(before.status, before.all).toBe(0);
    expect(before.stdout).toContain('3 checked, 0 failed'); // task, step, Run

    const out = readOutput();
    const r = recordGate();
    expect(r.status, r.all).toBe(0);

    const gate = readGate();
    expect(gate.id).toBe(GATE);
    expect(gate.task_id).toBe(TASK);
    expect(gate.step_id).toBe(STEP);
    expect(gate.reviewer_run_id).toBe(RUN);
    expect(gate.artifact_refs).toEqual(REFS.split(','));
    expect(gate.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Reviewer 의 것은 값 그대로 — 여러 줄 text, 따옴표·콜론·'#' 가 YAML 을 거쳐도 같다.
    expect(gate.verdict).toBe(out.verdict);
    expect(gate.checks).toEqual(out.checks);
    expect(gate.done_when).toEqual(out.done_when);
    expect(gate.comments).toEqual(out.comments);
    expect(gate.comments[0]).toEqual({ severity: 'risk', class: 'B', text: expect.stringContaining('\n') });
    expect(gate.checks.map((c: Json) => c.kind)).toEqual(expect.arrayContaining(['deterministic', 'semantic']));
    // Gate 에 없는 것
    expect(gate).not.toHaveProperty('packet_gaps');
    expect(gate).not.toHaveProperty('annotations');
    expect(Object.keys(gate).sort()).toEqual(
      ['artifact_refs', 'checks', 'comments', 'created_at', 'done_when', 'id', 'reviewer_run_id', 'step_id', 'task_id', 'verdict'].sort(),
    );

    const after = validateData();
    expect(after.status, after.all).toBe(0);
    expect(after.stdout).toContain('4 checked, 0 failed'); // + Gate
  });

  it('packet_gaps 는 Run 기록으로 옮겨지고 Run 의 다른 필드는 같은 값·같은 타입이며 기존 내용은 글자 그대로 남는다', () => {
    const textBefore = readFileSync(runFile(), 'utf8');
    const runBefore = readRun();
    expect(runBefore).not.toHaveProperty('packet_gaps');

    expect(recordGate().status).toBe(0);

    const textAfter = readFileSync(runFile(), 'utf8');
    const runAfter = readRun();
    expect(textAfter.startsWith(textBefore)).toBe(true);
    expect(runAfter.packet_gaps).toEqual(readOutput().packet_gaps);
    const { packet_gaps: _moved, ...rest } = runAfter;
    expect(rest).toStrictEqual(runBefore);
    // 0단계의 Run 기록에서 타입이 흔들릴 수 있는 값들
    expect(runAfter.submitted_at).toBe('2026-01-01T00:10:00Z');
    expect(runAfter.ended_at).toBe('2026-01-01T00:15:00Z');
    expect(runAfter.output_attempts).toBe(1);
    expect(runAfter.backend_version).toBe('2.1.276');
    expect(validateData().status).toBe(0);
  });

  it('빈 comments 와 빈 packet_gaps 도 그대로 옮겨진다([] = 부족 없음)', () => {
    editOutput((out) => {
      out.comments = [];
      out.packet_gaps = [];
    });
    const r = recordGate();
    expect(r.status, r.all).toBe(0);
    expect(readGate().comments).toEqual([]);
    expect(readRun()).toHaveProperty('packet_gaps', []);
    const v = validateData();
    expect(v.status, v.all).toBe(0);
    expect(v.stdout).toContain('4 checked, 0 failed');
  });

  it('class A 인 지적이 있고 verdict 가 fail 이면 받아들인다', () => {
    editOutput((out) => {
      out.verdict = 'fail';
      out.comments[0].class = 'A';
    });
    const r = recordGate();
    expect(r.status, r.all).toBe(0);
    expect(readGate().verdict).toBe('fail');
    expect(validateData().status).toBe(0);
  });

  it('끝에 줄바꿈이 없는 Run 기록에도 packet_gaps 가 덧붙는다', () => {
    writeFileSync(runFile(), readFileSync(runFile(), 'utf8').trimEnd());
    const runBefore = readRun();
    expect(recordGate().status).toBe(0);
    const { packet_gaps, ...rest } = readRun();
    expect(packet_gaps).toEqual(readOutput().packet_gaps);
    expect(rest).toStrictEqual(runBefore);
    expect(validateData().status).toBe(0);
  });

  it('끝에 덧붙일 수 없는 모양(flow mapping)의 Run 기록은 문서를 고쳐 쓰되 다른 필드의 값은 그대로다', () => {
    const runBefore = readRun();
    writeFileSync(runFile(), `${JSON.stringify(runBefore)}\n`);
    expect(readRun()).toStrictEqual(runBefore);
    const r = recordGate();
    expect(r.status, r.all).toBe(0);
    const { packet_gaps, ...rest } = readRun();
    expect(packet_gaps).toEqual(readOutput().packet_gaps);
    expect(rest).toStrictEqual(runBefore);
    expect(validateData().status).toBe(0);
  });
});

describe('record-gate: 받을 때의 거부 — 유효한 예시에서 한 가지만 바꾼다', () => {
  const cases: { name: string; edit: (out: Json) => void; expected: (string | RegExp)[] }[] = [
    {
      name: '전부 문장인 comments (옛 형식)',
      edit: (out) => {
        out.comments = out.comments.map((c: Json) => `[${c.severity} / ${c.class}] ${c.text}`);
      },
      expected: ['reviewer-output.schema.json', '/comments/0 must be object'],
    },
    {
      name: '문장과 객체가 섞인 comments',
      edit: (out) => {
        out.comments[1] = '[note / C] 문장으로 쓴 지적';
      },
      expected: ['reviewer-output.schema.json', '/comments/1 must be object'],
    },
    {
      name: 'packet_gaps 누락',
      edit: (out) => {
        delete out.packet_gaps;
      },
      expected: ['reviewer-output.schema.json', "must have required property 'packet_gaps'"],
    },
    {
      name: '없는 severity 값',
      edit: (out) => {
        out.comments[0].severity = 'major';
      },
      expected: ['reviewer-output.schema.json', '/comments/0/severity must be equal to one of the allowed values'],
    },
    {
      name: 'class 누락',
      edit: (out) => {
        delete out.comments[1].class;
      },
      expected: ['reviewer-output.schema.json', "/comments/1 must have required property 'class'"],
    },
    {
      name: '정의되지 않은 최상위 필드 — annotations',
      edit: (out) => {
        out.annotations = [{ source: 'system', text: 'Reviewer 가 쓸 자리가 아니다' }];
      },
      expected: ['reviewer-output.schema.json', '/ must NOT have additional properties'],
    },
    {
      name: '정의되지 않은 최상위 필드 — 식별 필드(id)',
      edit: (out) => {
        out.id = 'G-001';
      },
      expected: ['reviewer-output.schema.json', '/ must NOT have additional properties'],
    },
    {
      name: '빈 문장이 든 packet_gaps',
      edit: (out) => {
        out.packet_gaps.push('');
      },
      expected: ['reviewer-output.schema.json', '/packet_gaps/2 must NOT have fewer than 1 characters'],
    },
    {
      name: 'class A 인 지적이 있는데 verdict 가 pass',
      edit: (out) => {
        out.comments[1].class = 'A';
      },
      expected: ['verdict is pass', '/comments/1/class is A'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const runBefore = readFileSync(runFile(), 'utf8');
      editOutput(c.edit);
      expectRejected(recordGate(), runBefore, c.expected);
      // 다른 이유로 거부된 것이 아니다 — 바꾸지 않은 예시는 같은 자리에서 받아들여진다.
      cpSync(join(FIXTURES, 'data', TASK, 'steps', STEP, 'runs', `${RUN}.output.json`), outFile());
      expect(recordGate().status).toBe(0);
    });
  }

  it('출력 파일이 JSON 이 아니다', () => {
    const runBefore = readFileSync(runFile(), 'utf8');
    writeFileSync(outFile(), 'verdict: pass\n');
    expectRejected(recordGate(), runBefore, ['not valid JSON']);
  });

  it('출력 파일이 없다', () => {
    const runBefore = readFileSync(runFile(), 'utf8');
    rmSync(outFile());
    expectRejected(recordGate(), runBefore, [`${RUN}.output.json not found`]);
  });

  it('Run 기록 파일이 없다', () => {
    rmSync(runFile());
    const r = recordGate();
    expect(r.status, r.all).toBe(1);
    expect(r.stderr).toContain(`${RUN}.yaml not found`);
    expect(existsSync(gateFile())).toBe(false);
    expect(existsSync(runFile())).toBe(false);
  });

  it('Run 기록이 Reviewer 의 것이 아니다', () => {
    writeFileSync(runFile(), readFileSync(runFile(), 'utf8').replace('role: reviewer', 'role: worker'));
    expectRejected(recordGate(), readFileSync(runFile(), 'utf8'), ['role is worker']);
  });

  it('Run 기록의 id 가 인자와 다르다', () => {
    writeFileSync(runFile(), readFileSync(runFile(), 'utf8').replace('id: R-002', 'id: R-003'));
    expectRejected(recordGate(), readFileSync(runFile(), 'utf8'), ['id is R-003']);
  });

  it('Run 기록이 Run 스키마에 맞지 않는다', () => {
    writeFileSync(runFile(), readFileSync(runFile(), 'utf8').replace('output_attempts: 1', 'output_attempts: 0'));
    expectRejected(recordGate(), readFileSync(runFile(), 'utf8'), ['run.schema.json', '/output_attempts must be >= 1']);
  });

  it('Gate 파일이 이미 있으면 거부하고 기존 Gate 와 Run 기록은 그대로다', () => {
    expect(recordGate().status).toBe(0);
    const gateBefore = readFileSync(gateFile(), 'utf8');
    const runBefore = readFileSync(runFile(), 'utf8');
    editOutput((out) => {
      out.packet_gaps = [];
      out.comments = [];
    });
    const r = recordGate();
    expect(r.status, r.all).toBe(1);
    expect(r.stderr).toContain('already exists');
    expect(readFileSync(gateFile(), 'utf8')).toBe(gateBefore);
    expect(readFileSync(runFile(), 'utf8')).toBe(runBefore);
  });

  it('gates 디렉터리를 만들 수 없으면 Run 기록을 고치기 전에 거부한다', () => {
    const runBefore = readFileSync(runFile(), 'utf8');
    writeFileSync(join(taskDir(), 'steps', STEP, 'gates'), 'not a directory');
    const r = recordGate();
    expect(r.status, r.all).toBe(1);
    expect(readFileSync(runFile(), 'utf8')).toBe(runBefore);
  });
});

describe('record-gate: Run 기록에 이미 packet_gaps 가 있을 때', () => {
  it('출력의 것과 같으면 받아들이고 Run 기록은 건드리지 않는다(Run 만 쓰이고 끝난 실행의 재실행)', () => {
    expect(recordGate().status).toBe(0);
    rmSync(join(taskDir(), 'steps', STEP, 'gates'), { recursive: true });
    const runBefore = readFileSync(runFile(), 'utf8');
    const r = recordGate();
    expect(r.status, r.all).toBe(0);
    expect(readFileSync(runFile(), 'utf8')).toBe(runBefore);
    expect(existsSync(gateFile())).toBe(true);
    expect(validateData().status).toBe(0);
  });

  it('출력의 것과 다르면 거부한다', () => {
    writeFileSync(runFile(), `${readFileSync(runFile(), 'utf8')}packet_gaps:\n  - 손으로 먼저 적어 둔 다른 내용\n`);
    expectRejected(recordGate(), readFileSync(runFile(), 'utf8'), ['already has packet_gaps']);
  });

  it('Run 에는 [] 가 있는데 출력에는 항목이 있으면 거부한다', () => {
    writeFileSync(runFile(), `${readFileSync(runFile(), 'utf8')}packet_gaps: []\n`);
    expectRejected(recordGate(), readFileSync(runFile(), 'utf8'), ['already has packet_gaps']);
  });
});

describe('record-gate: --annotations (Reviewer 가 아닌 출처의 정보)', () => {
  const fixtureAnnotations = join(FIXTURES, 'annotations.json');

  it('주면 Gate 의 annotations 에 source, text(, ref)가 담기고 validate-data 를 통과한다', () => {
    const r = recordGate('--annotations', fixtureAnnotations);
    expect(r.status, r.all).toBe(0);
    const gate = readGate();
    expect(gate.annotations).toEqual(JSON.parse(readFileSync(fixtureAnnotations, 'utf8')));
    expect(gate.annotations.map((a: Json) => a.source)).toEqual(['worker', 'system']);
    expect(gate.comments).toEqual(readOutput().comments); // Reviewer 의 지적과 섞이지 않는다
    expect(gate).not.toHaveProperty('packet_gaps');
    const v = validateData();
    expect(v.status, v.all).toBe(0);
    expect(v.stdout).toContain('4 checked, 0 failed');
  });

  it('옵션은 위치 인자 앞에 두어도 되고 --annotations=<file> 로 써도 되며 YAML 파일도 받는다', () => {
    const file = join(tmp, 'annotations.yaml');
    writeFileSync(file, '- source: system\n  text: "YAML 로 쓴 것: 콜론과 # 가 있다"\n');
    const r = node(RECORD_GATE, [`--annotations=${file}`, taskDir(), STEP, GATE, RUN, REFS]);
    expect(r.status, r.all).toBe(0);
    expect(readGate().annotations).toEqual([{ source: 'system', text: 'YAML 로 쓴 것: 콜론과 # 가 있다' }]);
    expect(validateData().status).toBe(0);
  });

  const bad: { name: string; value: unknown; expected: (string | RegExp)[] }[] = [
    { name: '없는 source', value: [{ source: 'reviewer', text: 'x' }], expected: ['gate-result.schema.json', '/annotations/0/source must be equal to one of the allowed values'] },
    { name: 'text 누락', value: [{ source: 'system' }], expected: ['gate-result.schema.json', "/annotations/0 must have required property 'text'"] },
    { name: '정의되지 않은 필드', value: [{ source: 'system', text: 'x', severity: 'risk' }], expected: ['gate-result.schema.json', '/annotations/0 must NOT have additional properties'] },
    { name: '배열이 아님', value: { source: 'system', text: 'x' }, expected: ['gate-result.schema.json', '/annotations must be array'] },
    { name: '빈 배열', value: [], expected: ['empty array'] },
  ];
  for (const c of bad) {
    it(`잘못된 값은 거부한다 — ${c.name}`, () => {
      const runBefore = readFileSync(runFile(), 'utf8');
      expectRejected(recordGate('--annotations', writeAnnotations(c.value)), runBefore, c.expected);
    });
  }

  it('파일이 없으면 거부한다', () => {
    const runBefore = readFileSync(runFile(), 'utf8');
    expectRejected(recordGate('--annotations', join(tmp, 'no-such-file.json')), runBefore, ['--annotations file not found']);
  });
});

describe('record-gate: 호출 형태', () => {
  it('위치 인자가 모자라거나 모르는 옵션이면 사용법을 출력하고 exit 2, 아무것도 쓰지 않는다', () => {
    const runBefore = readFileSync(runFile(), 'utf8');
    const few = node(RECORD_GATE, [taskDir(), STEP, GATE, RUN]);
    expect(few.status).toBe(2);
    expect(few.stderr).toContain('usage: record-gate');
    const unknown = recordGate('--force');
    expect(unknown.status).toBe(2);
    expect(existsSync(gateFile())).toBe(false);
    expect(readFileSync(runFile(), 'utf8')).toBe(runBefore);
  });

  it('task 디렉터리를 상대 경로로 주어도(절차 문서의 호출 예) 동작한다', () => {
    const r = spawnSync(process.execPath, [RECORD_GATE, join('data', TASK), STEP, GATE, RUN, REFS], { cwd: tmp, encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readGate().task_id).toBe(TASK);
    expect(validateData().status).toBe(0);
  });
});
