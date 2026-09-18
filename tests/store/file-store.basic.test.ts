import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConflictError, InvalidChangeError, SchemaViolationError, TaskNotFoundError } from '../../src/store/errors.js';
import type { Task } from '../../src/types/generated/index.js';
import { createdEvent, createSample, newStore, noteEvent, readText, sampleTask, snapshot, tempDataDir } from './helpers.js';

describe('FileStore: 생성, 조회, 이벤트 (AC2)', () => {
  it('createTask 는 ID 를 발급하고 devflow-data 배치대로 기록한다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const made = await store.createTask((id) => ({ task: sampleTask(id, { title: 'first' }), events: [createdEvent] }));

    expect(made.task.id).toBe('T-0001');
    expect(made.task.target.task_branch).toBe('task/T-0001'); // build 가 발급된 ID 를 받아 쓴다
    expect(made.events).toEqual([{ seq: 1, task_id: 'T-0001', ...createdEvent }]);
    expect(Object.keys(snapshot(dataDir)).sort()).toEqual(['T-0001/events.jsonl', 'T-0001/task.yaml']);

    const log = readText(join(dataDir, 'T-0001', 'events.jsonl'));
    expect(log.endsWith('\n')).toBe(true);
    expect(log.includes('\r')).toBe(false);
    expect(JSON.parse(log.trim())).toMatchObject({ seq: 1, task_id: 'T-0001', type: 'task.created' });
    expect(readText(join(dataDir, 'T-0001', 'task.yaml'))).toContain('title: first');
  });

  it('get 과 list 로 조회한다. list 는 ID 순이고 status 로 거른다', async () => {
    const store = newStore(tempDataDir());
    await createSample(store, { title: 'a' });
    await createSample(store, { title: 'b', status: 'done' });
    await createSample(store, { title: 'c' });

    expect((await store.get('task', { taskId: 'T-0002' }))?.title).toBe('b');
    expect(await store.get('task', { taskId: 'T-0099' })).toBeUndefined();
    expect(await store.get('task', { taskId: '../escape' })).toBeUndefined();

    const all = await store.list('task', {});
    expect(all.items.map((t) => t.id)).toEqual(['T-0001', 'T-0002', 'T-0003']);
    expect(all.invalid).toEqual([]);
    expect((await store.list('task', { status: 'open' })).items.map((t) => t.title)).toEqual(['a', 'c']);
  });

  it('commit 은 이벤트에 연속된 seq 를 부여하고 엔티티 쓰기를 함께 반영한다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);

    const first = await store.commit(task.id, { events: [noteEvent('one'), noteEvent('two')] });
    expect(first.events.map((e) => e.seq)).toEqual([2, 3]);

    const second = await store.commit(task.id, { writes: [{ kind: 'task', value: { ...task, title: 'renamed' } }], events: [noteEvent('three')] });
    expect(second.events.map((e) => e.seq)).toEqual([4]);
    expect((await store.get('task', { taskId: task.id }))?.title).toBe('renamed');

    expect((await store.readEvents(task.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await store.readEvents(task.id, { afterSeq: 2 })).map((e) => e.seq)).toEqual([3, 4]);
    expect(Object.keys(snapshot(dataDir)).sort()).toEqual(['T-0001/events.jsonl', 'T-0001/task.yaml']); // .pending 이 남지 않는다
  });

  it('expectedLastSeq 가 다르면 ConflictError 이고 아무것도 기록하지 않는다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    await store.commit(task.id, { expectedLastSeq: 1, events: [noteEvent('ok')] });

    const before = snapshot(dataDir);
    await expect(store.commit(task.id, { expectedLastSeq: 1, events: [noteEvent('stale')] })).rejects.toBeInstanceOf(ConflictError);
    expect(snapshot(dataDir)).toEqual(before);
  });

  it('Change 를 함수로 주면 lock 안에서의 lastSeq 를 받는다', async () => {
    const store = newStore(tempDataDir());
    const task = await createSample(store);
    await store.commit(task.id, ({ lastSeq }) => ({ events: [noteEvent(`after-${lastSeq}`)] }));
    expect((await store.readEvents(task.id)).at(-1)?.data).toEqual({ note: 'after-1' });
  });

  it('없는 Task 에 대한 commit 과 readEvents 는 TaskNotFoundError', async () => {
    const store = newStore(tempDataDir());
    await expect(store.commit('T-0042', { events: [noteEvent('x')] })).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(store.readEvents('T-0042')).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(store.readEvents('not-an-id')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('잘못된 Change 는 InvalidChangeError', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const other = await createSample(store);

    await expect(store.commit(task.id, { events: [] as never })).rejects.toBeInstanceOf(InvalidChangeError);
    await expect(store.commit(task.id, { writes: [{ kind: 'task', value: other }], events: [noteEvent('x')] })).rejects.toBeInstanceOf(InvalidChangeError);
    await expect(store.createTask(() => ({ task: sampleTask('T-9999'), events: [createdEvent] }))).rejects.toBeInstanceOf(InvalidChangeError);
    // 실패한 createTask 의 ID 디렉터리는 남지 않는다
    expect(existsSync(join(dataDir, 'T-0003'))).toBe(false);
  });
});

describe('FileStore: 스키마 검증 (AC5)', () => {
  it('스키마를 위반하는 쓰기는 디스크를 건드리기 전에 거부된다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const before = snapshot(dataDir);

    const badTask = { ...task, status: 'nonsense' } as unknown as Task;
    const writeError = await store.commit(task.id, { writes: [{ kind: 'task', value: badTask }], events: [noteEvent('x')] }).catch((e) => e);
    expect(writeError).toBeInstanceOf(SchemaViolationError);
    expect(writeError.phase).toBe('write');

    const badEvent = { type: 'no.such.type', actor: 'system', at: '2026-01-01T00:00:00Z' } as never;
    await expect(store.commit(task.id, { events: [noteEvent('ok'), badEvent] })).rejects.toBeInstanceOf(SchemaViolationError);

    await expect(store.createTask((id) => ({ task: { ...sampleTask(id), acceptance_criteria: [] } as never, events: [createdEvent] }))).rejects.toBeInstanceOf(SchemaViolationError);

    expect(snapshot(dataDir)).toEqual(before);
    expect((await store.readEvents(task.id)).length).toBe(1);
  });

  it('손상된 엔티티의 읽기는 오류로 드러나고, list 는 나머지를 돌려준다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    await createSample(store);
    await createSample(store);
    await createSample(store);
    writeFileSync(join(dataDir, 'T-0002', 'task.yaml'), 'id: T-0002\ntitle: broken\n');
    writeFileSync(join(dataDir, 'T-0003', 'task.yaml'), 'title: [unclosed');

    const error = await store.get('task', { taskId: 'T-0002' }).catch((e) => e);
    expect(error).toBeInstanceOf(SchemaViolationError);
    expect(error.phase).toBe('read');
    expect(error.subject).toBe('task T-0002'); // 저장 위치가 아닌 식별자

    const listed = await store.list('task', {});
    expect(listed.items.map((t) => t.id)).toEqual(['T-0001']);
    expect(listed.invalid.map((i) => i.subject)).toEqual(['task T-0002', 'task T-0003']);
  });

  it('이벤트 로그의 손상(스키마 위반, seq 의 빈틈·중복)은 읽을 때 드러난다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const a = await createSample(store);
    const b = await createSample(store);
    const c = await createSample(store);
    const line = (seq: number, taskId: string, type = 'task.requirement_added') => `${JSON.stringify({ seq, task_id: taskId, type, actor: 'system', at: '2026-01-01T00:00:00Z' })}\n`;

    appendFileSync(join(dataDir, a.id, 'events.jsonl'), line(3, a.id)); // 빈틈
    appendFileSync(join(dataDir, b.id, 'events.jsonl'), line(1, b.id)); // 중복
    appendFileSync(join(dataDir, c.id, 'events.jsonl'), line(2, c.id, 'no.such.type')); // 스키마 위반

    for (const id of [a.id, b.id, c.id]) {
      const error = await store.readEvents(id).catch((e) => e);
      expect(error, id).toBeInstanceOf(SchemaViolationError);
      expect(error.phase).toBe('read');
    }
  });

  it('버려진 ID(이벤트 없는 디렉터리)는 존재하지 않는 Task 다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    await createSample(store);
    // build 가 실패한 createTask 는 디렉터리를 치우지만, 치우지 못한 경우를 흉내 낸다
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dataDir, 'T-0002'));
    writeFileSync(join(dataDir, 'T-0002', 'events.jsonl'), '');

    expect(await store.get('task', { taskId: 'T-0002' })).toBeUndefined();
    expect((await store.list('task', {})).items.map((t) => t.id)).toEqual(['T-0001']);
    await expect(store.readEvents('T-0002')).rejects.toBeInstanceOf(TaskNotFoundError);
    expect((await createSample(store)).id).toBe('T-0003'); // 버려진 ID 는 재사용하지 않는다
  });
});
