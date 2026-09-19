// commit 식별자 (docs/design/store.md 3.5, 5절 F12 — T-0005 AC3 의 Store 쪽).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommitOutcomeUnknownError, InvalidChangeError } from '../../src/store/errors.js';
import { nodeFileOps } from '../../src/store/file/index.js';
import type { NewEvent } from '../../src/store/types.js';
import { createdEvent, createSample, ioError, newStore, noteEvent, opsWith, sampleTask, snapshot, tempDataDir } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isEvents = (p: string) => p.endsWith('events.jsonl');

describe('commit 식별자 (store.md 3.5, AC3)', () => {
  it('한 commit 의 이벤트 모두에 같은 식별자, 서로 다른 commit(과 createTask)에 서로 다른 식별자. CommitResult 에서 보인다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const created = await store.createTask((id) => ({ task: sampleTask(id), events: [createdEvent, noteEvent('with-create')] }));
    const first = await store.commit(created.task.id, { events: [noteEvent('a'), noteEvent('b'), noteEvent('c')] });
    const second = await store.commit(created.task.id, ({ lastSeq }) => ({ events: [noteEvent(`after-${lastSeq}`)] }));

    expect(first.commitId).toMatch(UUID);
    expect(first.events.map((e) => e.commit_id)).toEqual([first.commitId, first.commitId, first.commitId]);
    expect(second.events.map((e) => e.commit_id)).toEqual([second.commitId]);
    const createId = created.events[0]!.commit_id;
    expect(created.events.map((e) => e.commit_id)).toEqual([createId, createId]);
    expect(new Set([createId, first.commitId, second.commitId]).size).toBe(3);

    // 기록된 이벤트에도 같은 값이 있다
    const stored = await store.readEvents(created.task.id);
    expect(stored.map((e) => e.commit_id)).toEqual([createId, createId, first.commitId, first.commitId, first.commitId, second.commitId]);

    // 이벤트 줄의 필드 순서는 seq, task_id, commit_id, 나머지
    const lines = readFileSync(join(dataDir, created.task.id, 'events.jsonl'), 'utf8').trim().split('\n');
    for (const line of lines) expect(Object.keys(JSON.parse(line)).slice(0, 3)).toEqual(['seq', 'task_id', 'commit_id']);
  });

  it('식별자는 호출마다 새로 만든 UUID 다 — 겹치지 않고, 시각·호스트·경로를 담지 않는다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push((await store.commit(task.id, { events: [noteEvent(`n${i}`)] })).commitId);
    expect(new Set(ids).size).toBe(30);
    for (const id of ids) expect(id).toMatch(UUID); // 16진수와 하이픈뿐이다
  });

  it('호출자가 이벤트에 commit_id 를 담아 보내면 InvalidChangeError 이고 아무것도 기록되지 않는다 (타입을 우회한 경우)', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const before = snapshot(dataDir);
    const forged = { ...noteEvent('forged'), commit_id: '3f2b8c1e-0a4d-4e5f-9b6a-7c8d9e0f1a2b' } as NewEvent;
    await expect(store.commit(task.id, { events: [noteEvent('ok'), forged] })).rejects.toBeInstanceOf(InvalidChangeError);
    await expect(store.commit(task.id, () => ({ events: [forged] }))).rejects.toBeInstanceOf(InvalidChangeError);
    await expect(store.createTask((id) => ({ task: sampleTask(id), events: [forged] }))).rejects.toBeInstanceOf(InvalidChangeError);
    expect(snapshot(dataDir)).toEqual(before);
  });

  it('결과를 알 수 없게 되면 CommitOutcomeUnknownError 에 식별자가 있고, 성립했다면 기록된 이벤트의 commit_id 가 그 값이다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    let appended = false;
    // 이벤트는 모두 쓰였지만(append 뒤 fsync 실패 같은 경우) 그 자리에서 다시 읽지도 못한다
    const store = newStore(dataDir, {
      ops: opsWith({
        append: async (p, d) => {
          await nodeFileOps.append(p, d);
          if (isEvents(p)) {
            appended = true;
            throw ioError('EIO');
          }
        },
        readFile: async (p) => (appended && isEvents(p) ? Promise.reject(ioError('EIO')) : nodeFileOps.readFile(p)),
      }),
    });
    const error = await store.commit(task.id, { events: [noteEvent('x'), noteEvent('y')] }).catch((e) => e);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error.commitId).toMatch(UUID);
    expect(error.message).toContain(error.commitId);
    const landed = await newStore(dataDir).readEvents(task.id, { afterSeq: error.firstSeq - 1 });
    expect(landed.map((e) => e.commit_id)).toEqual([error.commitId, error.commitId]);
  });

  it('createTask 의 CommitOutcomeUnknownError 에도 식별자가 있다', async () => {
    const dataDir = tempDataDir();
    let appended = false;
    const store = newStore(dataDir, {
      ops: opsWith({
        append: async (p, d) => {
          await nodeFileOps.append(p, d);
          if (isEvents(p)) {
            appended = true;
            throw ioError('EIO');
          }
        },
        readFile: async (p) => (appended && isEvents(p) ? Promise.reject(ioError('EIO')) : nodeFileOps.readFile(p)),
      }),
    });
    const error = await store.createTask((id) => ({ task: sampleTask(id), events: [createdEvent] })).catch((e) => e);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error.firstSeq).toBe(1);
    expect((await newStore(dataDir).readEvents(error.taskId)).map((e) => e.commit_id)).toEqual([error.commitId]);
  });
});
