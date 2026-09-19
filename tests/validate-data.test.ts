// scripts/validate-data.mjs 를 자식 프로세스로 실제로 실행해 검사한다(T-0005 의 AC11, 그리고 스키마 로더의 통합).
// 입력 예시는 tests/fixtures/validate-data/data/ 에 있다 — 데이터 디렉터리의 모양 그대로라, 임시 디렉터리에 복사한 뒤
// 같은 명령을 손으로 돌려 재현할 수 있다. 예시에는 Step 수준·Task 수준 runs/ 의 Run 이 아닌 파일(R-NNN.output.yaml,
// R-NNN.work-notes.md), 두 모양의 Artifact meta(stored_in: store / repo), next_step.step 이 있는 Decision, commit_id 가
// 있는 이벤트와 없는 이벤트가 들어 있다.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './store/paths.js';

const VALIDATE_DATA = join(REPO_ROOT, 'scripts', 'validate-data.mjs');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'validate-data', 'data');
const TASK = 'T-9002';
/** 예시의 검사 대상 수: task 1, decision 1, Task 수준 Run 1, step 1, Step 수준 Run 1, Artifact meta 2, 이벤트 3. */
const FIXTURE_CHECKED = 10;

type Json = Record<string, any>;

let tmp: string;
let dataDir: string;
const stepDir = () => join(dataDir, TASK, 'steps', 'step-001');
const metaFile = (name: string, version = 1) => join(stepDir(), 'artifacts', name, `v${version}.meta.yaml`);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'devflow-validate-data-'));
  dataDir = join(tmp, 'data');
  cpSync(FIXTURES, dataDir, { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function validateData() {
  const r = spawnSync(process.execPath, [VALIDATE_DATA, dataDir], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
const readYaml = (file: string): Json => parse(readFileSync(file, 'utf8'));
const editYaml = (file: string, edit: (value: Json) => void) => {
  const value = readYaml(file);
  edit(value);
  writeFileSync(file, stringify(value));
};
/** FAIL 로 보고된 파일의 목록. */
const failedLabels = (stderr: string) => [...stderr.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);

describe('validate-data', () => {
  it('예시 데이터가 0 failed 로 통과한다 — Artifact meta 를 세고, runs/ 의 Run 이 아닌 파일은 세지 않는다', () => {
    const r = validateData();
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain(`${FIXTURE_CHECKED} checked, 0 failed`);
    expect(r.stderr).toBe('');
  });

  it('잘못된 Artifact meta 를 FAIL 로 보고하고 exit 1 이다 (AC11)', () => {
    editYaml(metaFile('plan'), (m) => {
      delete m.content_key; // stored_in: store 인데 content_key 가 없다
    });
    const r = validateData();
    expect(r.status, r.all).toBe(1);
    expect(failedLabels(r.stderr)).toEqual([`${TASK}/steps/step-001/artifacts/plan/v1.meta.yaml`]);
    expect(r.stdout).toContain(`${FIXTURE_CHECKED} checked, 1 failed`);
  });

  it('meta 의 여러 잘못을 각각의 파일로 보고한다', () => {
    editYaml(metaFile('plan'), (m) => {
      m.content_key = 'runs/R-002.work-notes.md'; // blob key 가 아니라 경로
    });
    editYaml(metaFile('change'), (m) => {
      m.paths = ['C:/work/example-project/docs/example.md']; // 로컬 경로
    });
    // 새 버전의 meta 도 검사 대상이다
    mkdirSync(join(stepDir(), 'artifacts', 'plan'), { recursive: true });
    writeFileSync(metaFile('plan', 2), stringify({ ...readYaml(metaFile('change')), ref: 'artifact://T-9002/step-001/plan@v2', name: 'plan', version: 2, type: 'document', paths: undefined }));
    const r = validateData();
    expect(r.status, r.all).toBe(1);
    expect(failedLabels(r.stderr).sort()).toEqual([
      `${TASK}/steps/step-001/artifacts/change/v1.meta.yaml`,
      `${TASK}/steps/step-001/artifacts/plan/v1.meta.yaml`,
      `${TASK}/steps/step-001/artifacts/plan/v2.meta.yaml`,
    ]);
    expect(r.stderr).toContain('/content_key must match pattern');
    expect(r.stderr).toContain('/paths/0 must match pattern');
    expect(r.stdout).toContain(`${FIXTURE_CHECKED + 1} checked, 3 failed`);
  });

  it('artifacts/ 아래의 meta 가 아닌 파일은 읽지 않는다', () => {
    writeFileSync(join(stepDir(), 'artifacts', 'plan', 'v1.md'), '# 본문\n');
    writeFileSync(join(stepDir(), 'artifacts', 'plan', 'notes.yaml'), 'not: an artifact\n');
    const r = validateData();
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain(`${FIXTURE_CHECKED} checked, 0 failed`);
  });

  it('Step 수준 runs/ 도 R-NNN.yaml 만 Run 으로 읽는다 — 출력 파일을 Run 이름으로 바꾸면 그때는 Run 으로 검사되어 FAIL 이다', () => {
    // 예시의 steps/step-001/runs/R-002.output.yaml 은 Run 이 아니다. 지금은 세지 않는다(첫 테스트).
    renameSync(join(stepDir(), 'runs', 'R-002.output.yaml'), join(stepDir(), 'runs', 'R-003.yaml'));
    const r = validateData();
    expect(r.status, r.all).toBe(1);
    expect(failedLabels(r.stderr)).toEqual([`${TASK}/steps/step-001/runs/R-003.yaml`]);
  });

  it('Decision 의 next_step.step 을 step 의 정의로 검사한다 (파일을 가로지르는 $ref 가 validate-data 에서 풀린다)', () => {
    const file = join(dataDir, TASK, 'decisions', 'D-001.yaml');
    editYaml(file, (d) => {
      d.next_step.step.inputs = 'step-001 의 산출물을 읽는다'; // 서술 문장
      d.next_step.step.status = 'defined'; // Step 의 정의에 없는 필드
    });
    const r = validateData();
    expect(r.status, r.all).toBe(1);
    expect(failedLabels(r.stderr)).toEqual([`${TASK}/decisions/D-001.yaml`]);
    expect(r.stderr).toContain('/next_step/step/inputs must be array');
    expect(r.stderr).toContain('/next_step/step must NOT have unevaluated properties');
  });

  it('이벤트의 actor 형식과 commit_id 를 검사한다', () => {
    const file = join(dataDir, TASK, 'events.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    lines[1].actor = 'role:admin';
    lines[2].commit_id = 'NOT-A-UUID';
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const r = validateData();
    expect(r.status, r.all).toBe(1);
    expect(failedLabels(r.stderr)).toEqual([`${TASK}/events.jsonl:2`, `${TASK}/events.jsonl:3`]);
    expect(r.stderr).toContain('/actor must match pattern');
    expect(r.stderr).toContain('/commit_id must match pattern');
  });
});
