// Task 디렉터리와 Step 디렉터리를 가리는 규칙이 validate-data, Store, check-store-read 의 사본에서 같은가 (T-0006 AC5, S4).
// 규칙은 src/store/file/names.mjs 한 곳에 있고 layout.ts 와 validate-data 가 그것을 import 한다. check-store-read 는 일부러 사본을 둔다.
// 지금까지 규칙이 서로 달랐던 이름 — T-12(4자리 미만), steps/ 아래의 step-<숫자> 가 아닌 디렉터리, steps/ 안의 일반 파일 — 에서 세 쪽의
// 판단을 실제로 돌려 대 본다. 규칙 안의 이름(step-9 등)에서는 세 쪽 모두 그것을 읽는다는 것도 함께 본다(검사가 눈을 감고 있지 않은지).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEP_DIR, TASK_DIR } from '../../src/store/file/names.mjs';
import { createSample, newStore, tempDataDir } from './helpers.js';
import { BUILD_DIR, REPO_ROOT } from './paths.js';
import { event, step } from './records.js';

const BROKEN = 'broken: true\n';

function run(script: string, dataDir: string) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', script), dataDir], {
    encoding: 'utf8',
    env: { ...process.env, DEVFLOW_STORE_BUILD: BUILD_DIR },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

/** Store 로 쓴 Task 하나(T-0001, step-001)가 있는 데이터 디렉터리. */
async function dataWithOneStep() {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  const task = await createSample(store);
  await store.commit(task.id, { writes: [{ kind: 'step', value: step(task.id, 'step-001') }], events: [event('step.defined')] });
  return { dataDir, store, taskId: task.id };
}

const put = (path: string, content = BROKEN) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

describe('Task·Step 디렉터리의 이름 규칙 — validate-data, Store, check-store-read 가 같은 판단을 한다 (AC5)', () => {
  it('규칙 밖의 이름(T-12, steps/draft/, steps/README.md, steps/ 아래의 파일 step-002)은 세 쪽 모두 읽지 않고, validate-data 는 죽지 않는다', async () => {
    const { dataDir, store, taskId } = await dataWithOneStep();
    put(join(dataDir, 'T-12', 'task.yaml'));
    put(join(dataDir, 'T-12', 'events.jsonl'), 'not json\n');
    put(join(dataDir, taskId, 'steps', 'draft', 'step.yaml'));
    put(join(dataDir, taskId, 'steps', 'draft', 'runs', 'R-009.yaml'));
    put(join(dataDir, taskId, 'steps', 'README.md'), '# notes\n');
    put(join(dataDir, taskId, 'steps', 'step-002'), 'a file, not a directory\n');

    // validate-data: 읽었다면 FAIL 이 나왔을 내용이다. 처리되지 않은 예외(ENOENT/ENOTDIR)로 죽지 않는다.
    const v = run('validate-data.mjs', dataDir);
    expect(v.status, v.all).toBe(0);
    expect(v.stderr).toBe('');
    expect(v.stdout).toContain('0 failed');

    // Store
    const tasks = await store.list('task', {});
    expect(tasks.items.map((t) => t.id)).toEqual([taskId]);
    expect(tasks.invalid).toEqual([]);
    const steps = await store.list('step', { taskId });
    expect(steps.items.map((s) => s.id)).toEqual(['step-001']);
    expect(steps.invalid).toEqual([]);
    expect((await store.list('run', { taskId })).items).toEqual([]);
    expect((await store.list('run', { taskId })).invalid).toEqual([]);

    // check-store-read 의 사본: 센 수가 Store 가 읽은 수와 같다
    const c = run('check-store-read.mjs', dataDir);
    expect(c.status, c.all).toBe(0);
    expect(c.stdout).toContain('task: 1 read / 1 directories, invalid 0');
    expect(c.stdout).toContain(`${taskId}: step 1/1, decision 0/0, feedback 0/0, run 0/0, gate_result 0/0, artifact 0/0, blob 0/0`);
  });

  it('규칙 안의 이름(T-<4자리 이상>, steps/step-<숫자>/ — 3자리가 아닌 step-9 포함)은 세 쪽 모두 읽는다', async () => {
    const { dataDir, store, taskId } = await dataWithOneStep();
    put(join(dataDir, taskId, 'steps', 'step-9', 'step.yaml'));
    put(join(dataDir, taskId, 'steps', 'step-9', 'runs', 'R-009.yaml'));
    put(join(dataDir, 'T-12345', 'task.yaml'));
    put(join(dataDir, 'T-12345', 'events.jsonl'), `${JSON.stringify({ seq: 1, task_id: 'T-12345', type: 'task.created', actor: 'system', at: '2026-01-01T00:00:00Z' })}\n`);

    const v = run('validate-data.mjs', dataDir);
    expect(v.status).toBe(1);
    const failed = [...v.stderr.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]).sort();
    expect(failed).toEqual([`${taskId}/steps/step-9/runs/R-009.yaml`, `${taskId}/steps/step-9/step.yaml`, 'T-12345/task.yaml']);

    const tasks = await store.list('task', {});
    expect(tasks.invalid.map((i) => i.subject)).toEqual([expect.stringContaining('T-12345')]);
    const steps = await store.list('step', { taskId });
    expect(steps.invalid.map((i) => i.subject)).toEqual([expect.stringContaining('step-9')]);
    expect((await store.list('run', { taskId })).invalid.map((i) => i.subject)).toEqual([expect.stringContaining('R-009')]);

    // check-store-read: 사본이 같은 디렉터리를 센다 — 센 파일 수 = Store 가 읽은 것(items) + 읽지 못한 것(invalid)
    const c = run('check-store-read.mjs', dataDir);
    expect(c.status).toBe(1);
    expect(c.stdout).toContain('task: 1 read / 2 directories, invalid 1');
    expect(c.stderr).toContain(`FAIL ${taskId} step: invalid`);
    expect(c.stderr).toContain(`FAIL ${taskId} step: read 1, files 2`);
    expect(c.stderr).toContain(`FAIL ${taskId} run: read 0, files 1`);
  });

  it('step.yaml 이 없는 Step 디렉터리는 Store 가 Step 으로 세지 않고, validate-data 는 죽지 않고 FAIL 로 보인다', async () => {
    const { dataDir, store, taskId } = await dataWithOneStep();
    mkdirSync(join(dataDir, taskId, 'steps', 'step-002', 'runs'), { recursive: true });
    expect((await store.list('step', { taskId })).items.map((s) => s.id)).toEqual(['step-001']);
    const v = run('validate-data.mjs', dataDir);
    expect(v.status).toBe(1);
    expect(v.stderr).toContain(`FAIL ${taskId}/steps/step-002/step.yaml 이 없다`);
  });

  it('규칙은 한 곳에 있다 — layout.ts 와 validate-data 는 names.mjs 를 import 하고 자기 정규식을 두지 않는다', () => {
    const layout = readFileSync(join(REPO_ROOT, 'src', 'store', 'file', 'layout.ts'), 'utf8');
    const validateData = readFileSync(join(REPO_ROOT, 'scripts', 'validate-data.mjs'), 'utf8');
    for (const source of [layout, validateData]) {
      expect(source).toMatch(/from '(\.\/|\.\.\/src\/store\/file\/)names\.mjs'/);
      // T-\d, step-\d, D-/F-/R-/G-\d, v\d+\.meta 의 정규식 사본이 없다
      expect(source).not.toMatch(/\/\^(T-|step-|[DFRG]-|v\\d)/);
    }
    expect(TASK_DIR.test('T-0001') && !TASK_DIR.test('T-12')).toBe(true);
    expect(STEP_DIR.test('step-9') && !STEP_DIR.test('draft')).toBe(true);
  });
});
