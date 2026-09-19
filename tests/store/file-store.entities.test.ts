// 나머지 여섯 kind 와 blob (docs/design/store.md 3.1, 3.3 — T-0005 AC4).
// 0단계의 한 Step 치 기록을 Store 로만 쓰고(파일을 직접 쓰지 않는다) task branch 의 validate-data 를 그 디렉터리에 실제로 실행한다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobRef } from '../../src/store/blob-ref.js';
import { SchemaViolationError } from '../../src/store/errors.js';
import type { FileStore } from '../../src/store/file/index.js';
import { nodeFileOps } from '../../src/store/file/index.js';
import { createSample, ioError, newStore, opsWith, snapshot, tempDataDir } from './helpers.js';
import { REPO_ROOT } from './paths.js';
import { codeChange, decision, event, feedback, gate, run, step, storedDocument } from './records.js';

function validateData(dataDir: string) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'validate-data.mjs'), dataDir], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, all: `${r.stdout}\n${r.stderr}` };
}

/**
 * 0단계에서 한 Step 을 끝까지 돌 때 손으로 쓰던 기록 전부를 Store 로 쓴다. ID 는 모두 nextId·nextArtifactVersion 으로 받는다.
 * Planner 의 Task 수준 Run 과 출력 → Decision → Step → Worker 의 Step 수준 Run 과 작업 노트(blob), Artifact 둘 → Gate 와 로그(blob),
 * Reviewer 의 Step 수준 Run → 승인 Feedback(Step 수준)과 Step 의 상태 전이 → 요구사항 Feedback(Task 수준).
 */
async function recordOneStep(store: FileStore, taskId: string) {
  const ids: Record<string, string> = {};
  await store.commit(taskId, (ctx) => {
    const runId = (ids.planner = ctx.nextId('run'));
    const decisionId = (ids.decision = ctx.nextId('decision'));
    return {
      writes: [
        { kind: 'run', value: run(taskId, runId, { role: 'planner' }) },
        { kind: 'decision', value: decision(taskId, decisionId, runId) },
      ],
      blobs: [{ owner: { taskId, runId }, name: 'output.yaml', content: 'id: D-001\n' }],
      events: [event('run.completed', { run_id: runId }), event('decision.made', { ref: decisionId, actor: 'role:planner' })],
    };
  });
  await store.commit(taskId, (ctx) => {
    const stepId = (ids.step = ctx.nextId('step'));
    return { writes: [{ kind: 'step', value: step(taskId, stepId, 'defined', ids.decision) }], events: [event('step.defined', { step_id: stepId })] };
  });
  const stepId = ids.step!;
  await store.commit(taskId, (ctx) => {
    const runId = (ids.worker = ctx.nextId('run'));
    const notes = blobRef({ taskId, stepId, runId }, 'work-notes');
    return {
      writes: [
        { kind: 'run', value: run(taskId, runId, { stepId }) },
        { kind: 'artifact', value: storedDocument(taskId, stepId, 'plan', ctx.nextArtifactVersion(stepId, 'plan'), runId, notes) },
        { kind: 'artifact', value: codeChange(taskId, stepId, 'change', ctx.nextArtifactVersion(stepId, 'change'), runId, notes) },
      ],
      blobs: [{ owner: { taskId, stepId, runId }, name: 'work-notes', content: '# 작업 노트\n' }],
      events: [event('run.completed', { run_id: runId, step_id: stepId }), event('artifact.version_added', { step_id: stepId, ref: `artifact://${taskId}/${stepId}/plan@v1` })],
    };
  });
  await store.commit(taskId, (ctx) => {
    const reviewer = (ids.reviewer = ctx.nextId('run'));
    const gateId = (ids.gate = ctx.nextId('gate_result'));
    const log = blobRef({ taskId, stepId, gateId }, 'deterministic');
    return {
      writes: [
        { kind: 'run', value: run(taskId, reviewer, { stepId, role: 'reviewer' }) },
        { kind: 'gate_result', value: { ...gate(taskId, stepId, gateId, [`artifact://${taskId}/${stepId}/plan@v1`], log), reviewer_run_id: reviewer } },
      ],
      blobs: [
        { owner: { taskId, stepId, gateId }, name: 'deterministic', content: '## typecheck\npass\n' },
        { owner: { taskId, stepId, runId: reviewer }, name: 'output.json', content: new TextEncoder().encode('{"verdict":"pass"}') },
      ],
      events: [event('gate.completed', { step_id: stepId, ref: gateId })],
    };
  });
  await store.commit(taskId, (ctx) => {
    const approval = (ids.approval = ctx.nextId('feedback'));
    const requirement = (ids.requirement = ctx.nextId('feedback'));
    return {
      writes: [
        { kind: 'feedback', value: feedback(taskId, approval, { stepId, kind: 'approval', artifactRef: `artifact://${taskId}/${stepId}/plan@v1` }) },
        { kind: 'feedback', value: feedback(taskId, requirement) },
        { kind: 'step', value: step(taskId, stepId, 'closed', ids.decision) },
      ],
      events: [
        event('feedback.added', { ref: approval, step_id: stepId }),
        event('artifact.approved', { ref: `artifact://${taskId}/${stepId}/plan@v1`, step_id: stepId }),
        event('step.status_changed', { step_id: stepId, data: { from: 'running', to: 'closed' } }),
        event('feedback.added', { ref: requirement }),
      ],
    };
  });
  return ids;
}

describe('FileStore: 0단계의 한 Step 치 기록을 Store 로만 쓴다 (AC4)', () => {
  it('파일이 store.md 3.1·3.3 의 자리(= repo devflow-data 의 실제 배치)에 놓이고 validate-data 가 0 failed 다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const ids = await recordOneStep(store, task.id);

    // 발급된 ID: kind 마다 1 부터, Run 은 두 수준을 합쳐, Feedback 은 한 컨텍스트에서 연달아
    expect(ids).toEqual({ planner: 'R-001', decision: 'D-001', step: 'step-001', worker: 'R-002', reviewer: 'R-003', gate: 'G-001', approval: 'F-001', requirement: 'F-002' });

    // 실제 기록의 배치: Task 수준 runs/ 에 Planner 의 Run 과 출력, Step 수준 runs/ 에 Run 과 작업 노트(runs/R-NNN.work-notes.md),
    // gates/ 에 Gate 와 로그(gates/G-NNN.deterministic.md), Task 수준과 Step 수준의 feedback/, artifacts/<name>/v1.meta.yaml
    expect(Object.keys(snapshot(dataDir)).sort()).toEqual(
      [
        'T-0001/task.yaml',
        'T-0001/events.jsonl',
        'T-0001/decisions/D-001.yaml',
        'T-0001/runs/R-001.yaml',
        'T-0001/runs/R-001.output.yaml',
        'T-0001/feedback/F-002.yaml',
        'T-0001/steps/step-001/step.yaml',
        'T-0001/steps/step-001/runs/R-002.yaml',
        'T-0001/steps/step-001/runs/R-002.work-notes.md',
        'T-0001/steps/step-001/runs/R-003.yaml',
        'T-0001/steps/step-001/runs/R-003.output.json',
        'T-0001/steps/step-001/artifacts/plan/v1.meta.yaml',
        'T-0001/steps/step-001/artifacts/change/v1.meta.yaml',
        'T-0001/steps/step-001/gates/G-001.yaml',
        'T-0001/steps/step-001/gates/G-001.deterministic.md',
        'T-0001/steps/step-001/feedback/F-001.yaml',
      ].sort(),
    );
    expect(readFileSync(join(dataDir, 'T-0001', 'steps', 'step-001', 'runs', 'R-002.work-notes.md'), 'utf8')).toBe('# 작업 노트\n');

    // task branch 의 validate-data: task 1, decision 1, Run 3, step 1, Gate 1, Feedback 2, meta 2, 이벤트 1+2+1+2+1+4 = 11 → 22
    const r = validateData(dataDir);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain('22 checked, 0 failed');
  });

  it('쓴 것이 get·list·getBlob 으로 되읽힌다. Run·Feedback 의 get 은 수준을 몰라도 찾는다', async () => {
    const store = newStore(tempDataDir());
    const task = await createSample(store);
    const t = task.id;
    await recordOneStep(store, t);

    expect((await store.get('step', { taskId: t, stepId: 'step-001' }))?.status).toBe('closed'); // 가변: 같은 자리에 쓰면 교체
    expect((await store.get('decision', { taskId: t, id: 'D-001' }))?.planner_run_id).toBe('R-001');
    expect((await store.get('run', { taskId: t, id: 'R-001' }))?.step_id).toBeUndefined(); // Task 수준
    expect((await store.get('run', { taskId: t, id: 'R-002' }))?.step_id).toBe('step-001'); // Step 수준
    expect((await store.get('feedback', { taskId: t, id: 'F-001' }))?.kind).toBe('approval');
    expect((await store.get('feedback', { taskId: t, id: 'F-002' }))?.kind).toBe('requirement');
    expect((await store.get('gate_result', { taskId: t, stepId: 'step-001', id: 'G-001' }))?.reviewer_run_id).toBe('R-003');
    expect(await store.get('gate_result', { taskId: t, stepId: 'step-002', id: 'G-001' })).toBeUndefined(); // Gate 의 key 에는 Step 이 있다
    const plan = await store.get('artifact', { ref: `artifact://${t}/step-001/plan@v1` });
    expect(plan?.content_key).toBe(`blob:${t}/step-001/R-002.work-notes`);
    expect(await store.get('artifact', { ref: `artifact://${t}/step-001/plan@v2` })).toBeUndefined();

    // 없는 것, 모양이 틀린 key 는 undefined (디스크 밖을 가리킬 수 없다)
    expect(await store.get('run', { taskId: t, id: 'R-099' })).toBeUndefined();
    expect(await store.get('run', { taskId: t, id: '../runs/R-001' })).toBeUndefined();
    expect(await store.get('decision', { taskId: 'T-0099', id: 'D-001' })).toBeUndefined();
    expect(await store.get('artifact', { ref: 'artifact://T-0001/step-001/../plan@v1' })).toBeUndefined();

    const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);
    expect(text(await store.getBlob(plan!.content_key!))).toBe('# 작업 노트\n');
    expect(text(await store.getBlob(`blob:${t}/R-001.output.yaml`))).toBe('id: D-001\n');
    expect(text(await store.getBlob(`blob:${t}/step-001/G-001.deterministic`))).toBe('## typecheck\npass\n');
    expect(text(await store.getBlob(`blob:${t}/step-001/R-003.output.json`))).toBe('{"verdict":"pass"}');
    expect(await store.getBlob(`blob:${t}/step-001/R-099.work-notes`)).toBeUndefined(); // 없다
    expect(await store.getBlob(`blob:${t}/step-001/R-002.yaml`)).toBeUndefined(); // 문법에 맞지 않는다 — Run 기록 자체는 blob 이 아니다
    expect(await store.getBlob('blob:key')).toBeUndefined();

    const ids = <T extends { id?: string; ref?: string }>(r: { items: T[]; invalid: unknown[] }) => {
      expect(r.invalid).toEqual([]);
      return r.items.map((x) => x.id ?? x.ref);
    };
    expect(ids(await store.list('step', { taskId: t }))).toEqual(['step-001']);
    expect(ids(await store.list('step', { taskId: t, status: 'running' }))).toEqual([]);
    expect(ids(await store.list('decision', { taskId: t }))).toEqual(['D-001']);
    expect(ids(await store.list('run', { taskId: t }))).toEqual(['R-001', 'R-002', 'R-003']); // 두 수준, 번호 순. blob 은 세지 않는다
    expect(ids(await store.list('run', { taskId: t, stepId: null }))).toEqual(['R-001']);
    expect(ids(await store.list('run', { taskId: t, stepId: 'step-001' }))).toEqual(['R-002', 'R-003']);
    expect(ids(await store.list('run', { taskId: t, role: 'reviewer' }))).toEqual(['R-003']);
    expect(ids(await store.list('feedback', { taskId: t }))).toEqual(['F-001', 'F-002']);
    expect(ids(await store.list('feedback', { taskId: t, stepId: null }))).toEqual(['F-002']);
    expect(ids(await store.list('feedback', { taskId: t, kind: 'approval' }))).toEqual(['F-001']);
    expect(ids(await store.list('gate_result', { taskId: t }))).toEqual(['G-001']); // gates/ 의 로그 blob 은 세지 않는다
    expect(ids(await store.list('gate_result', { taskId: t, stepId: 'step-002' }))).toEqual([]);
    expect(ids(await store.list('artifact', { taskId: t }))).toEqual([`artifact://${t}/step-001/change@v1`, `artifact://${t}/step-001/plan@v1`]);
    expect(ids(await store.list('artifact', { taskId: t, stepId: 'step-001', name: 'plan' }))).toEqual([`artifact://${t}/step-001/plan@v1`]);
    expect(ids(await store.list('run', { taskId: 'T-0099' }))).toEqual([]); // 없는 Task
  });

  it('뒷정리(rename)를 마치지 못한 commit 의 새 기록과 blob 도 get·list·getBlob 에 보인다 (store.md 2.4 의 tmp 읽기)', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const t = task.id;
    let blocked = true; // 다른 프로그램이 tmp 를 붙들고 있는 상황
    const store = newStore(dataDir, {
      ops: opsWith({ rename: async (from, to) => (blocked && from.endsWith('.tmp') ? Promise.reject(ioError('EPERM')) : nodeFileOps.rename(from, to)) }),
    });
    await store.commit(t, {
      writes: [{ kind: 'run', value: run(t, 'R-001', { stepId: 'step-001' }) }],
      blobs: [{ owner: { taskId: t, stepId: 'step-001', runId: 'R-001' }, name: 'work-notes', content: 'pending' }],
      events: [event('run.completed')],
    });
    expect(Object.keys(snapshot(dataDir)).some((f) => f.includes('.pending-'))).toBe(true);
    expect((await store.get('run', { taskId: t, id: 'R-001' }))?.step_id).toBe('step-001');
    expect((await store.list('run', { taskId: t })).items.map((r) => r.id)).toEqual(['R-001']);
    expect(new TextDecoder().decode(await store.getBlob(`blob:${t}/step-001/R-001.work-notes`))).toBe('pending');
    blocked = false;
    await store.commit(t, { events: [event('run.submitted')] }); // 다음 commit 이 뒷정리를 마친다
    expect(Object.keys(snapshot(dataDir)).some((f) => f.includes('.pending-'))).toBe(false);
    expect(new TextDecoder().decode(await store.getBlob(`blob:${t}/step-001/R-001.work-notes`))).toBe('pending');
  });

  it('두 수준에 같은 ID 의 Run 이 있으면(손으로 만든 손상) get 은 모호함을 SchemaViolationError(read)로 드러낸다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    await store.commit(task.id, { writes: [{ kind: 'run', value: run(task.id, 'R-001', { stepId: 'step-001' }) }], events: [event('run.submitted')] });
    // Store 는 이런 상태를 만들지 않는다(3.2 의 유일성 검사). 사람이 파일을 복사한 경우를 흉내 낸다
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dataDir, task.id, 'runs'));
    writeFileSync(join(dataDir, task.id, 'runs', 'R-001.yaml'), readFileSync(join(dataDir, task.id, 'steps', 'step-001', 'runs', 'R-001.yaml')));
    const error = await store.get('run', { taskId: task.id, id: 'R-001' }).catch((e) => e);
    expect(error).toBeInstanceOf(SchemaViolationError);
    expect(error.phase).toBe('read');
    expect(error.subject).toBe(`run ${task.id}/R-001`); // 저장 위치가 아닌 식별자
  });

  it('list 는 모양이 맞는데 읽지 못한 파일을 invalid 에 담는다 — 스키마 위반, 자리와 맞지 않는 값', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const t = task.id;
    await store.commit(t, {
      writes: [
        { kind: 'run', value: run(t, 'R-001', { stepId: 'step-001' }) },
        { kind: 'run', value: run(t, 'R-002', { stepId: 'step-001' }) },
        { kind: 'run', value: run(t, 'R-003', { stepId: 'step-001' }) },
      ],
      events: [event('run.submitted')],
    });
    const runs = join(dataDir, t, 'steps', 'step-001', 'runs');
    writeFileSync(join(runs, 'R-002.yaml'), 'id: R-002\n'); // 스키마 위반
    writeFileSync(join(runs, 'R-003.yaml'), readFileSync(join(runs, 'R-001.yaml'))); // 내용은 R-001 — 이 자리의 것이 아니다
    const listed = await store.list('run', { taskId: t });
    expect(listed.items.map((r) => r.id)).toEqual(['R-001']);
    expect(listed.invalid.map((i) => i.subject)).toEqual([`run ${t}/R-002`, `run ${t}/R-003`]);
    expect(listed.invalid[1]!.issues[0]!.message).toContain('does not belong to this place');
    await expect(store.get('run', { taskId: t, id: 'R-003' })).rejects.toBeInstanceOf(SchemaViolationError);
  });
});
