// propose-step(다시 씀)·define-step·request-revision·approve-step·add-feedback 입구를 자식 프로세스로 실행한다 (T-0006 step-004 ③).
// 사람이 한 일의 입구는 --actor human:<id> 가 없으면 사용법 오류다. 전체 흐름은 tests/step-round-flow.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { submitRun } from '../src/commands/index.js';
import { ctxOf } from './commands/round-helpers.js';
import { allText, containsPath, entryRunner, validateData } from './entry-helpers.js';
import { contentSnapshot, createSample, newStore, tempDataDir } from './store/helpers.js';
import { stepDefinition } from './store/records.js';

const entry = entryRunner('plan-entries');
const decisionYaml = (extra: Record<string, unknown> = {}) =>
  stringify({ after_step: null, action: 'next_step', rationale: '예시', next_step: { step: stepDefinition() }, packet_gaps: [], ...extra });

async function planning() {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  const taskId = (await createSample(store)).id;
  await submitRun(ctxOf(store), { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'new' });
  const yaml = (rel: string) => parse(readFileSync(join(dataDir, taskId, rel), 'utf8')) as Record<string, any>;
  return { dataDir, taskId, yaml };
}

function expectUnchanged(dataDir: string, name: string, args: string[], status: number, reason: RegExp) {
  const before = contentSnapshot(dataDir);
  const r = entry.run(name, args);
  expect(r.status, `${name} ${args.join(' ')}\n${r.all}`).toBe(status);
  expect(r.stderr).toMatch(reason);
  expect(contentSnapshot(dataDir)).toEqual(before);
}

describe('propose-step 입구 (commands.recordDecision)', () => {
  it('<data-dir> <task-id> <planner-run-id> <output.yaml>: Decision·원문 blob·Step 제안, 입력 경로는 기록되지 않는다, validate-data 0 failed', async () => {
    const { dataDir, taskId, yaml } = await planning();
    const text = decisionYaml({ id: 'D-777', created_at: '2000-01-01T00:00:00Z' });
    const r = entry.run('propose-step', [dataDir, taskId, 'R-001', entry.file(text, 'R-001.output.yaml'), '--output-attempts', '1']);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(/^recorded D-001 \(next_step\) from R-001, proposed step-001; seq/);
    expect(yaml('decisions/D-001.yaml')).toMatchObject({ id: 'D-001', planner_run_id: 'R-001' });
    expect(yaml('steps/step-001/step.yaml')).toMatchObject({ status: 'proposed', created_from: 'D-001' });
    expect(readFileSync(join(dataDir, taskId, 'runs', 'R-001.output.yaml'), 'utf8')).toBe(text);
    expect(validateData(dataDir).status).toBe(0);
    expect(containsPath(allText(dataDir), entry.inputs)).toBe(false);
  });

  it('옛 모양·모자란 인자는 exit 2, 닫히지 않은 Step 이 있으면 exit 1 — 아무것도 쓰지 않는다', async () => {
    const { dataDir, taskId } = await planning();
    expectUnchanged(dataDir, 'propose-step', [join(dataDir, taskId), 'D-001', 'step-001'], 2, /옛 인자 모양/);
    expectUnchanged(dataDir, 'propose-step', [dataDir, taskId, 'R-001'], 2, /usage: propose-step/);
    expectUnchanged(dataDir, 'propose-step', [dataDir, taskId, 'R-001', entry.file('action: [', 'bad.yaml')], 1, /YAML\/JSON 이 아니다/);
    expect(entry.run('propose-step', [dataDir, taskId, 'R-001', entry.file(decisionYaml())]).status).toBe(0);
    const store = newStore(dataDir);
    await submitRun(ctxOf(store), { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'new' });
    expectUnchanged(dataDir, 'propose-step', [dataDir, taskId, 'R-002', entry.file(decisionYaml())], 1, /닫히지 않은 Step\(step-001 proposed\)/);
  });
});

describe('사람이 한 일의 입구 — define-step, request-revision, approve-step, add-feedback', () => {
  it('--actor human:<id> 가 없거나 모양이 틀리면 사용법 오류(exit 2), 시각을 주려는 옵션도 exit 2 — 아무것도 쓰지 않는다', async () => {
    const { dataDir, taskId } = await planning();
    expect(entry.run('propose-step', [dataDir, taskId, 'R-001', entry.file(decisionYaml())]).status).toBe(0);
    const ref = `artifact://${taskId}/step-001/plan@v1`;
    const cases: Array<[string, string[], RegExp]> = [
      ['define-step', [dataDir, taskId, 'step-001'], /--actor 가 필요하다/],
      ['define-step', [dataDir, taskId, 'step-001', '--actor', 'system'], /human:<id> 모양이다/],
      ['define-step', [dataDir, taskId, 'step-001', '--actor', 'human:t', '--at', '2026-01-01T00:00:00Z'], /모르는 옵션 --at/],
      ['request-revision', [dataDir, taskId, 'step-001', ref, '--text', 't'], /--actor 가 필요하다/],
      ['request-revision', [dataDir, taskId, 'step-001', ref, '--actor', 'human:t'], /--text 와 --text-file 가운데 하나/],
      ['approve-step', [dataDir, taskId, 'step-001', '--text', '승인', '--actor', 'human:t'], /--gate 가 필요하다/],
      ['approve-step', [dataDir, taskId, 'step-001', '--gate', 'G-001', '--text', '승인'], /--actor 가 필요하다/],
      ['add-feedback', [dataDir, taskId, '--kind', 'question', '--channel', 'review', '--text', 'q'], /--actor 가 필요하다/],
    ];
    for (const [name, args, reason] of cases) expectUnchanged(dataDir, name, args, 2, reason);
  });

  it('define-step --edited 는 고친 정의를 반영하고 human_edit true — 거부(exit 1)는 아무것도 쓰지 않는다', async () => {
    const { dataDir, taskId, yaml } = await planning();
    expect(entry.run('propose-step', [dataDir, taskId, 'R-001', entry.file(decisionYaml())]).status).toBe(0);
    expectUnchanged(dataDir, 'define-step', [dataDir, taskId, 'step-001', '--edited', entry.file(stringify({ ...stepDefinition(), status: 'closed' })), '--actor', 'human:t'], 1, /definition.status: 도구가 채우는 필드다/);
    expectUnchanged(dataDir, 'approve-step', [dataDir, taskId, 'step-001', '--gate', 'G-001', '--text', '승인', '--actor', 'human:t'], 1, /proposed 다 — approveStep/);
    expectUnchanged(dataDir, 'add-feedback', [dataDir, taskId, '--kind', 'approval', '--channel', 'review', '--text', 'x', '--actor', 'human:t'], 1, /approval 는 받지 않는다/);
    const r = entry.run('define-step', [dataDir, taskId, 'step-001', '--edited', entry.file(stringify({ ...stepDefinition(), goal: '고친 목표' }), 'edited.yaml'), '--note', '고쳐서 확정', '--actor', 'human:t']);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(/defined step-001 on T-0001 \(human_edit true\)/);
    expect(yaml('steps/step-001/step.yaml')).toMatchObject({ status: 'defined', goal: '고친 목표', created_from: 'D-001' });
    expect(validateData(dataDir).status).toBe(0);
  });
});
