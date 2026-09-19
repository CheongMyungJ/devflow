// 덮어쓰기 방지와 쓰기 때의 확인 (docs/design/store.md 3.1, 3.2 — T-0005 AC6).
// 거부된 commit 은 어떤 쓰기도 이벤트도 blob 도 남기지 않는다: 디렉터리의 모든 파일과 크기(snapshot)와 이벤트 수를 함께 본다.
import { describe, expect, it } from 'vitest';
import { blobRef } from '../../src/store/blob-ref.js';
import { AlreadyExistsError, InvalidChangeError, SchemaViolationError } from '../../src/store/errors.js';
import type { FileStore } from '../../src/store/file/index.js';
import type { Change } from '../../src/store/types.js';
import { createSample, newStore, snapshot, tempDataDir } from './helpers.js';
import { codeChange, decision, event, feedback, gate, run, storedDocument } from './records.js';

const T = 'T-0001';
const S = 'step-001';
const notes = blobRef({ taskId: T, stepId: S, runId: 'R-002' }, 'work-notes');
const plan = storedDocument(T, S, 'plan', 1, 'R-002', notes);
const planRef = `artifact://${T}/${S}/plan@v1`;
const gate1 = gate(T, S, 'G-001', [planRef]);

/** 기록이 있는 Task: Step 수준 Run R-002 와 작업 노트, Artifact plan@v1, Gate G-001, Decision D-001, Step 수준 Feedback F-001. */
async function seeded(): Promise<{ dataDir: string; store: FileStore }> {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  await createSample(store);
  await store.commit(T, {
    writes: [
      { kind: 'decision', value: decision(T, 'D-001') },
      { kind: 'run', value: run(T, 'R-002', { stepId: S }) },
      { kind: 'artifact', value: plan },
      { kind: 'gate_result', value: gate1 },
      { kind: 'feedback', value: feedback(T, 'F-001', { stepId: S, kind: 'approval', artifactRef: planRef }) },
    ],
    blobs: [{ owner: { taskId: T, stepId: S, runId: 'R-002' }, name: 'work-notes', content: '# notes\n' }],
    events: [event('artifact.version_added')],
  });
  return { dataDir, store };
}

/** 거부되어야 할 commit: 거부 대상 하나에, 그 자체로는 문제없는 쓰기·blob·이벤트를 곁들인다. 하나도 남지 않아야 한다. */
const withBystanders = (change: Pick<Change, 'writes' | 'blobs'>): Change => ({
  writes: [{ kind: 'run', value: run(T, 'R-005', { stepId: S }) }, ...(change.writes ?? [])],
  blobs: [{ owner: { taskId: T, stepId: S, runId: 'R-005' }, name: 'work-notes', content: 'bystander' }, ...(change.blobs ?? [])],
  events: [event('run.submitted'), event('run.completed')],
});

async function expectRejected(store: FileStore, dataDir: string, change: Change, error: new (...args: never[]) => Error): Promise<Error> {
  const before = snapshot(dataDir);
  const eventsBefore = (await store.readEvents(T)).length;
  const thrown = await store.commit(T, change).catch((e: Error) => e);
  expect(thrown).toBeInstanceOf(error);
  expect(snapshot(dataDir)).toEqual(before); // 쓰기도 blob 도 .pending 도 남지 않았다
  expect((await store.readEvents(T)).length).toBe(eventsBefore); // 이벤트도
  return thrown as Error;
}

describe('덮어쓰기 방지 (store.md 3.2, AC6)', () => {
  it('이미 있는 Artifact 버전을 같은 key 로 쓰면 — 내용이 같아도 — AlreadyExistsError 이고 아무것도 기록되지 않는다', async () => {
    const { dataDir, store } = await seeded();
    const error = await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: plan }] }), AlreadyExistsError);
    expect((error as AlreadyExistsError).subject).toBe(`artifact ${planRef}`); // 저장 위치가 아닌 식별자
    // 승인 표시만 바꾼 meta 도 다시 쓸 수 없다 — Artifact meta 를 다시 쓰는 길은 없다(F-001 (1)(A))
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: { ...plan, approved: true } }] }), AlreadyExistsError);
    // 다음 버전은 쓸 수 있다
    await store.commit(T, { writes: [{ kind: 'artifact', value: { ...plan, ref: `artifact://${T}/${S}/plan@v2`, version: 2 } }], events: [event('artifact.version_added')] });
  });

  it('이미 있는 GateResult 를 같은 key 로 쓰면 — 내용이 같아도 — AlreadyExistsError 이고 아무것도 기록되지 않는다', async () => {
    const { dataDir, store } = await seeded();
    const error = await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'gate_result', value: gate1 }] }), AlreadyExistsError);
    expect((error as AlreadyExistsError).subject).toBe(`gate_result ${T}/${S}/G-001`);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'gate_result', value: { ...gate1, verdict: 'fail' } }] }), AlreadyExistsError);
  });

  it('Decision 과 blob 도 불변이다', async () => {
    const { dataDir, store } = await seeded();
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'decision', value: decision(T, 'D-001') }] }), AlreadyExistsError);
    const error = await expectRejected(
      store,
      dataDir,
      withBystanders({ blobs: [{ owner: { taskId: T, stepId: S, runId: 'R-002' }, name: 'work-notes', content: '# notes\n' }] }),
      AlreadyExistsError,
    );
    expect((error as AlreadyExistsError).subject).toBe(`blob ${notes}`);
  });

  it('Task 안의 ID 가 다른 자리(다른 수준, 다른 Step)에 있으면 가변 kind 라도 AlreadyExistsError', async () => {
    const { dataDir, store } = await seeded();
    // Step 수준의 R-002 가 있는데 step_id 없는 R-002
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: run(T, 'R-002') }] }), AlreadyExistsError);
    // 다른 Step 으로 옮기는 쓰기도
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: run(T, 'R-002', { stepId: 'step-002' }) }] }), AlreadyExistsError);
    // step-001 에 G-001 이 있는데 step-002 의 G-001
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'gate_result', value: gate(T, 'step-002', 'G-001', [planRef]) }] }), AlreadyExistsError);
    // Step 수준의 F-001 이 있는데 Task 수준의 F-001
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'feedback', value: feedback(T, 'F-001') }] }), AlreadyExistsError);
  });

  it('가변 kind 가 같은 자리의 같은 key 에 쓰는 것은 교체다', async () => {
    const { store } = await seeded();
    await store.commit(T, { writes: [{ kind: 'run', value: run(T, 'R-002', { stepId: S, status: 'failed' }) }], events: [event('run.failed')] });
    expect((await store.get('run', { taskId: T, id: 'R-002' }))?.status).toBe('failed');
    await store.commit(T, { writes: [{ kind: 'feedback', value: { ...feedback(T, 'F-001', { stepId: S, kind: 'approval', artifactRef: planRef }), response: 'ok' } }], events: [event('feedback.added')] });
    expect((await store.get('feedback', { taskId: T, id: 'F-001' }))?.response).toBe('ok');
  });
});

describe('쓰기 때의 확인 (store.md 3.1, 3.3) — 호출자의 버그는 InvalidChangeError 이고 아무것도 기록되지 않는다', () => {
  it('ID·Step ID 의 모양', async () => {
    const { dataDir, store } = await seeded();
    // Run 의 id 는 스키마의 pattern(^R-[0-9]{3,}$)이 먼저 막는다. 그 pattern 을 지나는 것 가운데 3자리 0 채움이 아닌 것은 Store 가 막는다
    for (const id of ['R-12', 'r-012', 'R-012.x', '../R-012']) {
      await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: run(T, id, { stepId: S }) }] }), SchemaViolationError);
    }
    for (const id of ['R-0012', 'R-000']) {
      await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: run(T, id, { stepId: S }) }] }), InvalidChangeError);
    }
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: run(T, 'R-012', { stepId: 'step-1' }) }] }), InvalidChangeError);
    // decision·feedback·gate-result 스키마의 id 에는 pattern 이 없다 — 모양은 Store 가 확인한다
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'decision', value: decision(T, 'D-1') }] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'feedback', value: feedback(T, 'feedback-1') }] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'gate_result', value: gate(T, S, 'G-1', [planRef]) }] }), InvalidChangeError);
  });

  it('값의 task_id 가 다른 Task, Artifact 의 ref 가 task_id·step_id·name·version 과 맞지 않음, 쓸 수 없는 Artifact 이름', async () => {
    const { dataDir, store } = await seeded();
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: run('T-0002', 'R-012') }] }), InvalidChangeError);
    const v2 = { ...plan, ref: `artifact://${T}/${S}/plan@v2`, version: 2 };
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: { ...v2, ref: `artifact://${T}/${S}/plan@v3` } }] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: { ...v2, name: 'other' } }] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: { ...v2, ref: `artifact://${T}/${S}/-x@v2`, name: '-x' } }] }), InvalidChangeError);
  });

  it('한 Change 안에서 같은 것(같은 key, 같은 ID)을 두 번 쓰기', async () => {
    const { dataDir, store } = await seeded();
    const r = run(T, 'R-012', { stepId: S });
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: r }, { kind: 'run', value: r }] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'run', value: r }, { kind: 'run', value: run(T, 'R-012') }] }), InvalidChangeError);
    const b = { owner: { taskId: T, stepId: S, runId: 'R-012' }, name: 'probe', content: 'x' };
    await expectRejected(store, dataDir, withBystanders({ blobs: [b, b] }), InvalidChangeError);
  });

  it('blob 의 소유자가 다른 Task 이거나 이름이 문법에 맞지 않음', async () => {
    const { dataDir, store } = await seeded();
    await expectRejected(store, dataDir, withBystanders({ blobs: [{ owner: { taskId: 'T-0002', runId: 'R-001' }, name: 'probe', content: 'x' }] }), InvalidChangeError);
    for (const name of ['yaml', 'work.notes', 'notes.md', '', '-x', 'x/y']) {
      await expectRejected(store, dataDir, withBystanders({ blobs: [{ owner: { taskId: T, stepId: S, runId: 'R-012' }, name, content: 'x' }] }), InvalidChangeError);
    }
  });

  it('Artifact 의 content_key·work_notes_key 는 같은 Task·Step 의 blob 이고, 이 commit 에서 쓰이거나 이미 있어야 한다 (Worker 가 정한 확인)', async () => {
    const { dataDir, store } = await seeded();
    const v = (key: string, field: 'content_key' | 'work_notes_key' = 'content_key') =>
      field === 'content_key' ? storedDocument(T, S, 'doc', 1, 'R-002', key) : codeChange(T, S, 'change', 1, 'R-002', key);
    // 없는 blob
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: v(`blob:${T}/${S}/R-002.missing`) }] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: v(`blob:${T}/${S}/R-002.missing`, 'work_notes_key') }] }), InvalidChangeError);
    // 다른 Step, Task 수준의 blob
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: v(`blob:${T}/step-002/R-002.work-notes`) }] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'artifact', value: v(`blob:${T}/R-002.work-notes`) }] }), InvalidChangeError);
    // 이미 있는 blob 을 가리키는 것, 같은 commit 에서 쓰는 blob 을 가리키는 것은 된다
    await store.commit(T, { writes: [{ kind: 'artifact', value: v(notes) }], events: [event('artifact.version_added')] });
    const probe = blobRef({ taskId: T, stepId: S, runId: 'R-002' }, 'probe');
    await store.commit(T, {
      writes: [{ kind: 'artifact', value: storedDocument(T, S, 'probe', 1, 'R-002', probe) }],
      blobs: [{ owner: { taskId: T, stepId: S, runId: 'R-002' }, name: 'probe', content: 'measured' }],
      events: [event('artifact.version_added')],
    });
    // 스키마가 요구하지 않는 stored_in 을 Store 가 더 요구하지 않는다 — stored_in 없는 옛 모양도 쓸 수 있다
    const { stored_in, ...old } = storedDocument(T, S, 'old-shape', 1, 'R-002', notes);
    await store.commit(T, { writes: [{ kind: 'artifact', value: old }], events: [event('artifact.version_added')] });
  });
});
