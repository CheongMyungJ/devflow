// Task 안의 ID 발급 (docs/design/store.md 3.4 — T-0005 AC5).
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaViolationError } from '../../src/store/errors.js';
import type { FileStore } from '../../src/store/file/index.js';
import type { CommitContext, IssuedIdKind } from '../../src/store/types.js';
import { createSample, newStore, spawnChild, tempDataDir } from './helpers.js';
import { REPO_ROOT } from './paths.js';
import { codeChange, decision, event, feedback, gate, run, step } from './records.js';

/** 컨텍스트만 받아 보는 commit. 발급받은 것을 돌려주고, 쓰기는 하지 않는다(이벤트 하나만). */
async function peek<T>(store: FileStore, taskId: string, look: (ctx: CommitContext) => T): Promise<T> {
  let seen: T | undefined;
  await store.commit(taskId, (ctx) => {
    seen = look(ctx);
    return { events: [event('ledger.updated')] };
  });
  return seen!;
}
const nextOfEach = (ctx: CommitContext) =>
  Object.fromEntries((['step', 'decision', 'feedback', 'gate_result', 'run'] as IssuedIdKind[]).map((kind) => [kind, ctx.nextId(kind)]));

describe('Task 안의 ID 발급 (store.md 3.4, AC5)', () => {
  it('기록이 없는 Task 에서는 kind 마다 001 부터, 같은 컨텍스트에서 다시 부르면 다음 번호', async () => {
    const store = newStore(tempDataDir());
    const task = await createSample(store);
    const got = await peek(store, task.id, (ctx) => ({
      first: nextOfEach(ctx),
      runs: [ctx.nextId('run'), ctx.nextId('run')],
      versions: [ctx.nextArtifactVersion('step-001', 'plan'), ctx.nextArtifactVersion('step-001', 'plan'), ctx.nextArtifactVersion('step-001', 'other')],
    }));
    expect(got).toEqual({
      first: { step: 'step-001', decision: 'D-001', feedback: 'F-001', gate_result: 'G-001', run: 'R-001' },
      runs: ['R-002', 'R-003'],
      versions: [1, 2, 1],
    });
  });

  it('기존 기록이 있는 Task: kind 마다 가장 큰 번호의 다음 — 빈 번호를 채우지 않고, 두 수준·모든 Step 을 합쳐, blob 만 있는 소유자 ID 도 센다', async () => {
    const store = newStore(tempDataDir());
    const task = await createSample(store);
    const t = task.id;
    const ref = (s: string, n: string, v: number) => `artifact://${t}/${s}/${n}@v${v}`;
    await store.commit(t, {
      writes: [
        { kind: 'decision', value: decision(t, 'D-001') },
        { kind: 'decision', value: decision(t, 'D-003') }, // D-002 는 비어 있다
        { kind: 'step', value: step(t, 'step-001') },
        { kind: 'step', value: step(t, 'step-002') },
        // Run: Task 수준 R-001·R-006, Step 수준 R-002~R-004 (T-0002 처럼 두 수준이 번호를 나눠 쓴다)
        { kind: 'run', value: run(t, 'R-001', { role: 'planner' }) },
        { kind: 'run', value: run(t, 'R-006', { role: 'planner' }) },
        { kind: 'run', value: run(t, 'R-002', { stepId: 'step-001' }) },
        { kind: 'run', value: run(t, 'R-003', { stepId: 'step-001' }) },
        { kind: 'run', value: run(t, 'R-004', { stepId: 'step-002' }) },
        // Feedback: Step 수준 F-001·F-002, Task 수준 F-004
        { kind: 'feedback', value: feedback(t, 'F-001', { stepId: 'step-001' }) },
        { kind: 'feedback', value: feedback(t, 'F-002', { stepId: 'step-002' }) },
        { kind: 'feedback', value: feedback(t, 'F-004') },
        // Gate: 여러 Step 에 걸쳐 — step-003 에는 step.yaml 이 없다
        { kind: 'gate_result', value: gate(t, 'step-001', 'G-001', [ref('step-001', 'plan', 1)]) },
        { kind: 'gate_result', value: gate(t, 'step-003', 'G-007', [ref('step-001', 'plan', 1)]) },
        // Artifact: step-001 의 change 는 v1·v2·v5
        ...[1, 2, 5].map((v) => ({ kind: 'artifact' as const, value: codeChange(t, 'step-001', 'change', v, 'R-002') })),
      ],
      // 기록 없이 blob 만 있는 소유자: Run R-012(실패한 실행의 기록, T-0001 의 R-012.failed.md 처럼), Gate G-009
      blobs: [
        { owner: { taskId: t, stepId: 'step-002', runId: 'R-012' }, name: 'failed', content: 'x' },
        { owner: { taskId: t, stepId: 'step-001', gateId: 'G-009' }, name: 'deterministic', content: 'x' },
      ],
      events: [event('ledger.updated')],
    });

    const got = await peek(store, t, (ctx) => ({
      next: nextOfEach(ctx),
      again: ctx.nextId('run'),
      change: ctx.nextArtifactVersion('step-001', 'change'),
      plan: ctx.nextArtifactVersion('step-001', 'plan'),
      other: ctx.nextArtifactVersion('step-002', 'change'),
    }));
    expect(got).toEqual({
      next: { step: 'step-004', decision: 'D-004', feedback: 'F-005', gate_result: 'G-010', run: 'R-013' },
      again: 'R-014',
      change: 6,
      plan: 1,
      other: 1,
    });
  });

  it('손으로 쓴 기존 기록(validate-data 의 예시 T-9002 — 실제 기록의 모양)에서도 파일 이름으로 센다', async () => {
    const dataDir = tempDataDir();
    cpSync(join(REPO_ROOT, 'tests', 'fixtures', 'validate-data', 'data', 'T-9002'), join(dataDir, 'T-9002'), { recursive: true });
    const store = newStore(dataDir);
    // runs/ 에는 R-001.yaml·R-001.output.yaml(Task 수준), steps/step-001/runs/ 에는 R-002.yaml·R-002.output.yaml·R-002.work-notes.md
    const got = await peek(store, 'T-9002', (ctx) => ({ ...nextOfEach(ctx), plan: ctx.nextArtifactVersion('step-001', 'plan') }));
    expect(got).toEqual({ step: 'step-002', decision: 'D-002', feedback: 'F-001', gate_result: 'G-001', run: 'R-003', plan: 2 });
  });

  it('발급하고 쓰지 않은 ID 는 소비되지 않는다 — 쓰지 않았거나 commit 이 실패하면 다음 commit 이 같은 번호를 준다', async () => {
    const store = newStore(tempDataDir());
    const task = await createSample(store);
    expect(await peek(store, task.id, (ctx) => ctx.nextId('run'))).toBe('R-001'); // 쓰지 않았다
    const failed = await store
      .commit(task.id, (ctx) => ({ writes: [{ kind: 'run', value: { ...run(task.id, ctx.nextId('run')), status: 'nonsense' as never } }], events: [event('run.submitted')] }))
      .catch((e) => e);
    expect(failed).toBeInstanceOf(SchemaViolationError); // 실패했다
    expect(await peek(store, task.id, (ctx) => ctx.nextId('run'))).toBe('R-001');
    await store.commit(task.id, (ctx) => ({ writes: [{ kind: 'run', value: run(task.id, ctx.nextId('run')) }], events: [event('run.submitted')] }));
    expect(await peek(store, task.id, (ctx) => ctx.nextId('run'))).toBe('R-002');
  });

  it('여러 프로세스가 같은 Task 에 동시에 발급·commit 해도 ID 가 겹치지 않는다', async () => {
    const PROCESSES = 6;
    const perProcess = 8;
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const barrier = join(dataDir, 'go');
    const children = Array.from({ length: PROCESSES }, (_, i) => spawnChild({ dataDir, action: 'issue', taskId: task.id, count: perProcess, label: `p${i}`, barrier }));
    await Promise.all(children.map((child) => child.waitFor('ready')));
    writeFileSync(barrier, '');
    // 겹친 ID 로 쓴 commit 은 AlreadyExistsError(Gate·Artifact 는 불변, Run 은 두 수준에 번갈아 쓴다)로 실패해 자식이 0 이 아닌 코드로 끝난다
    for (const result of await Promise.all(children.map((child) => child.exit))) expect(result.code, result.stderr).toBe(0);

    const total = PROCESSES * perProcess;
    const numbers = (items: Array<{ id: string }>) => items.map((x) => Number(x.id.slice(2)));
    const expected = Array.from({ length: total }, (_, i) => i + 1);
    const runs = await store.list('run', { taskId: task.id });
    const gates = await store.list('gate_result', { taskId: task.id });
    const feedbacks = await store.list('feedback', { taskId: task.id });
    const artifacts = await store.list('artifact', { taskId: task.id });
    for (const listed of [runs, gates, feedbacks, artifacts]) expect(listed.invalid).toEqual([]);
    expect(numbers(runs.items)).toEqual(expected); // 빈틈도 겹침도 없다
    expect(numbers(gates.items)).toEqual(expected);
    expect(numbers(feedbacks.items)).toEqual(expected);
    expect(artifacts.items.map((a) => a.version)).toEqual(expected);
    expect(runs.items.filter((r) => r.step_id === undefined).length).toBe(PROCESSES * (perProcess / 2)); // 두 수준에 나뉘어 있다
    // 한 commit 의 발급은 서로 짝이 맞는다: Gate 는 같은 commit 의 Artifact 를, Artifact 는 같은 commit 의 Run 을 가리킨다
    for (const [i, g] of gates.items.entries()) expect(g.artifact_refs).toEqual([artifacts.items[i]!.ref]);
    expect(artifacts.items.map((a) => a.run_id)).toEqual(runs.items.map((r) => r.id));

    // 실제로 경합했는지: 번호 순으로 본 발급자(Feedback 의 text 에 적힌 프로세스)가 여러 번 바뀐다
    const owners = feedbacks.items.map((f) => f.text);
    const switches = owners.filter((o, i) => i > 0 && o !== owners[i - 1]).length;
    expect(switches).toBeGreaterThan(PROCESSES);
  });
});
