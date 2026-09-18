import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTask, type CreateTaskInput } from '../../src/commands/index.js';
import { getTask, listTasks } from '../../src/queries/index.js';
import { SchemaViolationError } from '../../src/store/errors.js';
import { newStore, noteEvent, sampleTask, tempDataDir } from '../store/helpers.js';

const clock = { now: () => new Date('2026-09-18T00:00:00.000Z') };
const input = (title: string): CreateTaskInput => ({
  title,
  type: 'feature',
  goal: 'g',
  acceptance_criteria: [{ id: 'AC1', text: 't' }],
  target: { repo: 'r', base_branch: 'main' },
});

describe('queries.getTask / listTasks (AC6)', () => {
  it('getTask 는 없는 Task 에 undefined 를, 손상된 Task 에 오류를 돌려준다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createTask({ store, clock, actor: 'system' }, input('a'));

    expect(await getTask({ store }, task.id)).toEqual(task);
    expect(await getTask({ store }, 'T-0404')).toBeUndefined();

    writeFileSync(join(dataDir, task.id, 'task.yaml'), 'id: T-0001\n');
    await expect(getTask({ store }, task.id)).rejects.toBeInstanceOf(SchemaViolationError);
  });

  it('listTasks 는 ID 순으로 돌려주고 status 로 거른다', async () => {
    const store = newStore(tempDataDir());
    const ctx = { store, clock, actor: 'system' };
    const a = await createTask(ctx, input('a'));
    const b = await createTask(ctx, input('b'));
    await createTask(ctx, input('c'));
    await store.commit(b.id, { writes: [{ kind: 'task', value: { ...b, status: 'done' } }], events: [noteEvent('closed')] });

    expect((await listTasks({ store })).tasks.map((t) => t.title)).toEqual(['a', 'b', 'c']);
    expect((await listTasks({ store }, { status: 'open' })).tasks.map((t) => t.title)).toEqual(['a', 'c']);
    expect((await listTasks({ store }, { status: 'done' })).tasks.map((t) => t.id)).toEqual([b.id]);
    expect((await listTasks({ store }, { status: 'aborted' })).tasks).toEqual([]);
    expect(a.id).toBe('T-0001');
  });

  it('읽지 못한 Task 를 숨기지 않는다: 나머지와 함께, 무엇이 왜 읽히지 않는지 돌려준다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const ctx = { store, clock, actor: 'system' };
    await createTask(ctx, input('ok'));
    const broken = await createTask(ctx, input('broken'));
    writeFileSync(join(dataDir, broken.id, 'task.yaml'), `id: ${broken.id}\ntitle: broken\n`);

    const listed = await listTasks({ store });
    expect(listed.tasks.map((t) => t.title)).toEqual(['ok']);
    expect(listed.unreadable.map((u) => u.subject)).toEqual([`task ${broken.id}`]);
    expect(listed.unreadable[0]!.issues.length).toBeGreaterThan(0);
    // status 로 걸러도 읽지 못한 것은 계속 알린다(어느 status 인지 알 수 없으므로)
    expect((await listTasks({ store }, { status: 'done' })).unreadable.length).toBe(1);
  });

  it('sampleTask 와 같은 모양의 Task 를 직접 저장해도 같은 query 로 읽힌다 (commands 를 거치지 않은 데이터)', async () => {
    const store = newStore(tempDataDir());
    const made = await store.createTask((id) => ({ task: sampleTask(id), events: [{ type: 'task.created', actor: 'system', at: '2026-01-01T00:00:00Z' }] }));
    expect(await getTask({ store }, made.task.id)).toEqual(made.task);
  });
});
