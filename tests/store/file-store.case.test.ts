// 대소문자만 다른 key·Artifact 이름 (docs/design/store.md 3.2, 3.3 — T-0005 F-005).
// 대소문자를 가리지 않는 파일 시스템(NTFS 등)에서는 R-001.Notes 와 R-001.notes, plan 과 Plan 이 한 파일·한 디렉터리가 되어
// 불변 기록이 덮어쓰일 수 있다. Store 는 파일 시스템이 대소문자를 가리든 아니든 늘 거부한다.
// 각 테스트는 거부(오류의 종류)와 함께 먼저 쓴 기록의 내용·파일 목록·이벤트 수가 그대로인지 본다 —
// 덮어쓰기의 결과만 보면 대소문자를 가리는 파일 시스템에서는 결함이 드러나지 않는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobRef } from '../../src/store/blob-ref.js';
import { AlreadyExistsError, InvalidChangeError } from '../../src/store/errors.js';
import type { FileStore } from '../../src/store/file/index.js';
import type { BlobWrite, Change, EntityWrite } from '../../src/store/types.js';
import { createSample, newStore, snapshot, tempDataDir } from './helpers.js';
import { event, gate, run, storedDocument } from './records.js';

const T = 'T-0001';
const S = 'step-001';
const owner = { taskId: T, stepId: S, runId: 'R-001' };
const notesUpper = blobRef(owner, 'Notes'); // blob:T-0001/step-001/R-001.Notes
const notesLower = blobRef(owner, 'notes'); // blob:T-0001/step-001/R-001.notes
const FIRST = 'FIRST — the record that was written first\n';
const artifactOf = (name: string, version: number, stepId = S) => storedDocument(T, stepId, name, version, 'R-001', blobRef({ ...owner, stepId }, 'work-notes'));
const artifactWrite = (name: string, version: number, stepId = S): EntityWrite => ({ kind: 'artifact', value: artifactOf(name, version, stepId) });
const refOf = (name: string, version: number, stepId = S) => `artifact://${T}/${stepId}/${name}@v${version}`;

/** Step 수준 Run R-001, 그 blob R-001.Notes(내용 FIRST)와 R-001.work-notes, Artifact plan@v1 이 있는 Task. step-002 에도 같은 Run 의 작업 노트가 있다. */
async function seeded(): Promise<{ dataDir: string; store: FileStore }> {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  await createSample(store);
  await store.commit(T, {
    writes: [{ kind: 'run', value: run(T, 'R-001', { stepId: S }) }, artifactWrite('plan', 1)],
    blobs: [
      { owner, name: 'Notes', content: FIRST },
      { owner, name: 'work-notes', content: '# notes\n' },
      { owner: { ...owner, stepId: 'step-002' }, name: 'work-notes', content: '# notes 2\n' },
    ],
    events: [event('artifact.version_added')],
  });
  return { dataDir, store };
}

/** 거부 대상에 그 자체로는 문제없는 쓰기·blob·이벤트를 곁들인다. 하나도 남지 않아야 한다. */
const withBystanders = (change: { writes?: EntityWrite[]; blobs?: BlobWrite[] }): Change => ({
  writes: [{ kind: 'run', value: run(T, 'R-005', { stepId: S }) }, ...(change.writes ?? [])],
  blobs: [{ owner: { ...owner, runId: 'R-005' }, name: 'work-notes', content: 'bystander' }, ...(change.blobs ?? [])],
  events: [event('run.submitted'), event('run.completed')],
});

/** 모든 파일의 내용. snapshot(이름과 크기)만으로는 같은 크기의 덮어쓰기를 놓친다. */
function contents(dataDir: string): Record<string, string> {
  return Object.fromEntries(Object.keys(snapshot(dataDir)).map((rel) => [rel, readFileSync(join(dataDir, rel), 'utf8')]));
}

async function expectRejected(store: FileStore, dataDir: string, change: Change, error: new (...args: never[]) => Error): Promise<Error> {
  const before = contents(dataDir);
  const eventsBefore = (await store.readEvents(T)).length;
  const thrown = await store.commit(T, change).catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(error);
  expect(contents(dataDir)).toEqual(before); // 파일 목록(이름의 대소문자 포함)과 내용이 그대로다. .pending 도 남지 않았다
  expect((await store.readEvents(T)).length).toBe(eventsBefore);
  return thrown as Error;
}

const decode = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8'));

describe('대소문자만 다른 blob key (store.md 3.3, F-005)', () => {
  it('먼저 쓴 blob 이 디스크에 있으면 AlreadyExistsError 이고 그 blob 의 내용은 그대로다', async () => {
    const { dataDir, store } = await seeded();
    const error = await expectRejected(store, dataDir, withBystanders({ blobs: [{ owner, name: 'notes', content: 'second' }] }), AlreadyExistsError);
    expect((error as AlreadyExistsError).subject).toContain(`blob ${notesLower}`);
    expect((error as AlreadyExistsError).subject).toContain(notesUpper); // 부딪친 기록을 저장 위치가 아닌 식별자로 알린다
    expect(decode(await store.getBlob(notesUpper))).toBe(FIRST);
    // 확장자가 있어도, 대문자가 어디에 있어도 같다
    await expectRejected(store, dataDir, withBystanders({ blobs: [{ owner, name: 'NOTES', content: 'x' }] }), AlreadyExistsError);
    await expectRejected(store, dataDir, withBystanders({ blobs: [{ owner, name: 'Work-Notes', content: 'x' }] }), AlreadyExistsError);
    await store.commit(T, { blobs: [{ owner, name: 'probe.txt', content: 'p' }], events: [event('run.completed')] });
    await expectRejected(store, dataDir, withBystanders({ blobs: [{ owner, name: 'Probe.txt', content: 'q' }] }), AlreadyExistsError);
  });

  it('한 Change 안에서 대소문자만 다른 두 blob 은 InvalidChangeError 이고 어느 것도 기록되지 않는다', async () => {
    const { dataDir, store } = await seeded();
    const other = { ...owner, runId: 'R-002' };
    await expectRejected(
      store,
      dataDir,
      withBystanders({ blobs: [{ owner: other, name: 'Notes', content: 'one' }, { owner: other, name: 'notes', content: 'two' }] }),
      InvalidChangeError,
    );
    expect(await store.getBlob(blobRef(other, 'Notes'))).toBeUndefined();
    expect(await store.getBlob(blobRef(other, 'notes'))).toBeUndefined();
  });

  it('대소문자만 다른 key 로 읽으면 없는 것이다 — 다른 blob 의 내용을 돌려주지 않는다 (Worker 가 정한 것)', async () => {
    const { store } = await seeded();
    expect(await store.getBlob(notesLower)).toBeUndefined();
    expect(await store.getBlob(blobRef(owner, 'Work-notes'))).toBeUndefined();
    expect(decode(await store.getBlob(notesUpper))).toBe(FIRST);
  });

  it('다른 Step·다른 소유자의 같은 철자는 부딪치지 않는다', async () => {
    const { store } = await seeded();
    await store.commit(T, {
      blobs: [
        { owner: { ...owner, stepId: 'step-002' }, name: 'notes', content: 'other step' },
        { owner: { ...owner, runId: 'R-002' }, name: 'notes', content: 'other owner' },
      ],
      events: [event('run.completed')],
    });
    expect(decode(await store.getBlob(notesUpper))).toBe(FIRST);
  });
});

describe('대소문자만 다른 Artifact 이름 (store.md 3.2, F-005)', () => {
  it('같은 Step 에 먼저 쓴 이름이 디스크에 있으면 — 버전이 달라도 — AlreadyExistsError 이고 먼저 쓴 meta 는 그대로다', async () => {
    const { dataDir, store } = await seeded();
    const before = await store.get('artifact', { ref: refOf('plan', 1) });
    const error = await expectRejected(store, dataDir, withBystanders({ writes: [artifactWrite('Plan', 1)] }), AlreadyExistsError);
    expect((error as AlreadyExistsError).subject).toContain(`artifact ${refOf('Plan', 1)}`);
    expect((error as AlreadyExistsError).subject).toContain(refOf('plan', 1));
    await expectRejected(store, dataDir, withBystanders({ writes: [artifactWrite('Plan', 2)] }), AlreadyExistsError);
    await expectRejected(store, dataDir, withBystanders({ writes: [artifactWrite('PLAN', 7)] }), AlreadyExistsError);
    expect(await store.get('artifact', { ref: refOf('plan', 1) })).toEqual(before);
    const listed = await store.list('artifact', { taskId: T });
    expect(listed.invalid).toEqual([]);
    expect(listed.items.map((a) => a.ref)).toEqual([refOf('plan', 1)]);
    // 같은 철자의 다음 버전은 된다
    await store.commit(T, { writes: [artifactWrite('plan', 2)], events: [event('artifact.version_added')] });
  });

  it('한 Change 안에서 대소문자만 다른 이름은 — 버전이 달라도 — InvalidChangeError 이고 어느 것도 기록되지 않는다', async () => {
    const { dataDir, store } = await seeded();
    await expectRejected(store, dataDir, withBystanders({ writes: [artifactWrite('spec', 1), artifactWrite('Spec', 1)] }), InvalidChangeError);
    await expectRejected(store, dataDir, withBystanders({ writes: [artifactWrite('spec', 1), artifactWrite('Spec', 2)] }), InvalidChangeError);
    expect((await store.list('artifact', { taskId: T })).items.map((a) => a.ref)).toEqual([refOf('plan', 1)]);
  });

  it('대소문자만 다른 ref 로 읽으면 없는 것이다 (Worker 가 정한 것)', async () => {
    const { store } = await seeded();
    expect(await store.get('artifact', { ref: refOf('Plan', 1) })).toBeUndefined();
    expect((await store.get('artifact', { ref: refOf('plan', 1) }))?.name).toBe('plan');
  });

  it('다른 Step 의 같은 철자, 같은 Step 의 다른 이름은 부딪치지 않는다', async () => {
    const { store } = await seeded();
    await store.commit(T, { writes: [artifactWrite('Plan', 1, 'step-002'), artifactWrite('plan-b', 1)], events: [event('artifact.version_added')] });
    const refs = (await store.list('artifact', { taskId: T })).items.map((a) => a.ref);
    expect(refs).toEqual([refOf('plan', 1), refOf('plan-b', 1), refOf('Plan', 1, 'step-002')]);
  });
});

describe('기록 파일도 같다 — 대소문자 무시 비교는 계획한 모든 파일과 그 위의 디렉터리에 걸린다', () => {
  it('사람이 둔 g-002.yaml 이 있으면 G-002 를 쓰는 commit 은 AlreadyExistsError 다', async () => {
    const { dataDir, store } = await seeded();
    // Store 가 쓰지 않는 이름(Gate 기록도 blob 도 아니다). 대소문자를 가리지 않는 파일 시스템에서는 G-002.yaml 과 한 파일이다
    const stray = join(dataDir, T, 'steps', S, 'gates');
    await store.commit(T, { writes: [{ kind: 'gate_result', value: gate(T, S, 'G-001', [refOf('plan', 1)]) }], events: [event('gate.completed')] });
    writeFileSync(join(stray, 'g-002.yaml'), 'left by hand\n');
    await expectRejected(store, dataDir, withBystanders({ writes: [{ kind: 'gate_result', value: gate(T, S, 'G-002', [refOf('plan', 1)]) }] }), AlreadyExistsError);
    expect(readFileSync(join(stray, 'g-002.yaml'), 'utf8')).toBe('left by hand\n');
  });
});
