import { describe, expect, it } from 'vitest';
import { type CommandContext, createTask, type CreateTaskInput } from '../../src/commands/index.js';
import { getTask, listTasks } from '../../src/queries/index.js';
import { CommitOutcomeUnknownError, SchemaViolationError, StoreBusyError, StoreUnavailableError, TaskNotFoundError } from '../../src/store/errors.js';
import type { NewEvent, Store } from '../../src/store/types.js';
import type { Event, Task } from '../../src/types/generated/index.js';
import { newStore, snapshot, tempDataDir } from '../store/helpers.js';

const input: CreateTaskInput = {
  title: '주문 부분 취소 시 재고 미복원',
  type: 'bugfix',
  goal: '부분 취소 시 취소 수량만큼 재고가 복원되게 한다',
  acceptance_criteria: [{ id: 'AC1', text: '부분 취소 시 취소 수량만큼 재고 복원' }],
  target: { repo: 'shop', base_branch: 'main', scope_hint: ['src/order/'] },
};

const fixedClock = { now: () => new Date('2026-09-18T01:02:03.000Z') };
const context = (store: Store, overrides: Partial<CommandContext> = {}): CommandContext => ({ store, clock: fixedClock, actor: 'human:tester', ...overrides });

describe('commands.createTask (AC6)', () => {
  it('Task 를 저장하고 task.created 이벤트를 남긴다. 시스템이 채우는 필드는 발급된 ID, 주입된 시계, 행위자에서 온다', async () => {
    const store = newStore(tempDataDir());
    const task = await createTask(context(store, { systemSha: 'abc123' }), { ...input, branchSlug: 'Partial Cancel / 재고!' });

    expect(task).toMatchObject({
      id: 'T-0001',
      status: 'open',
      created_at: '2026-09-18T01:02:03.000Z',
      created_by: 'human:tester',
      target: { repo: 'shop', base_branch: 'main', task_branch: 'task/T-0001-partial-cancel', scope_hint: ['src/order/'] },
    });
    expect(await getTask({ store }, 'T-0001')).toEqual(task);
    expect(await store.readEvents('T-0001')).toEqual([
      { seq: 1, task_id: 'T-0001', type: 'task.created', actor: 'human:tester', at: '2026-09-18T01:02:03.000Z', system_sha: 'abc123' },
    ]);
  });

  it('branchSlug 가 없으면 task/<id>, systemSha 가 없으면 이벤트에 넣지 않는다', async () => {
    const store = newStore(tempDataDir());
    const task = await createTask(context(store), input);
    expect(task.target.task_branch).toBe('task/T-0001');
    expect((await store.readEvents(task.id))[0]).not.toHaveProperty('system_sha');
  });

  it('입력이 Task 스키마를 위반하면 아무것도 만들지 않고 SchemaViolationError', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    await expect(createTask(context(store), { ...input, acceptance_criteria: [] as never })).rejects.toBeInstanceOf(SchemaViolationError);
    await expect(createTask(context(store), { ...input, type: 'chore' as never })).rejects.toBeInstanceOf(SchemaViolationError);
    expect(await listTasks({ store })).toEqual({ tasks: [], unreadable: [] });
    expect(snapshot(dataDir)).toEqual({}); // 실패한 발행은 디렉터리도 남기지 않는다
    expect((await createTask(context(store), input)).id).toBe('T-0001');
  });

  it('Store 의 오류는 바꾸지 않고 그대로 올린다 (안내가 담긴 detail 이 사용자에게 닿아야 한다)', async () => {
    const busy = new StoreBusyError('T-0001', 'pid 123 가 쥐고 있다. … 를 삭제하면 풀린다');
    const store = { createTask: () => Promise.reject(busy) } as unknown as Store;
    await expect(createTask(context(store), input)).rejects.toBe(busy);
  });
});

describe('commands.createTask: 결과를 알 수 없는 commit 의 확인 (docs/design/commands.md 3절)', () => {
  /** createTask 가 build 를 부른 뒤 CommitOutcomeUnknownError 를 던지는 가짜 Store. landed 가 그 뒤 readEvents 가 돌려줄 내용이다. */
  function unknownOutcomeStore(
    landed: (sent: { task: Task; events: NewEvent[] }) => Event[] | Error,
    storedTask: (sent: Task) => Task | undefined | Error = (task) => task,
  ): Store {
    let sent: { task: Task; events: NewEvent[] } | undefined;
    return {
      get: async (_kind: string, key: { taskId: string }) => {
        expect(key).toEqual({ taskId: 'T-0007' });
        const result = storedTask(sent!.task);
        if (result instanceof Error) throw result;
        return result;
      },
      createTask: async (build: (id: string) => { task: Task; events: [NewEvent, ...NewEvent[]] }) => {
        sent = build('T-0007');
        throw new CommitOutcomeUnknownError('T-0007', 1);
      },
      readEvents: async (taskId: string, options?: { afterSeq?: number }) => {
        expect(taskId).toBe('T-0007');
        expect(options).toEqual({ afterSeq: 0 });
        const result = landed(sent!);
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as Store;
  }

  it('보낸 이벤트가 그 자리에 그대로 있으면 성립한 것이다 → Task 를 돌려준다', async () => {
    const store = unknownOutcomeStore((sent) => sent.events.map((e, i) => ({ ...e, seq: 1 + i, task_id: 'T-0007' }) as Event));
    const task = await createTask(context(store), input);
    expect(task.id).toBe('T-0007');
    expect(task.target.task_branch).toBe('task/T-0007');
  });

  it('Task 가 없으면 성립하지 않은 것이다 → 기록 안 됨을 뜻하는 StoreUnavailableError (원래 오류가 cause)', async () => {
    const store = unknownOutcomeStore(() => new TaskNotFoundError('T-0007'));
    const error = await createTask(context(store), input).catch((e) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect(error.cause).toBeInstanceOf(CommitOutcomeUnknownError);
  });

  it('그 자리에 다른 내용이 있으면 자기 것으로 오인하지 않는다', async () => {
    const other = (overrides: Partial<Event>) => (sent: { events: NewEvent[] }) => [{ ...sent.events[0]!, seq: 1, task_id: 'T-0007', ...overrides } as Event];
    for (const landed of [other({ actor: 'human:someone-else' }), other({ at: '2026-01-01T00:00:00.000Z' }), other({ seq: 2 }), other({ data: { extra: true } })]) {
      await expect(createTask(context(unknownOutcomeStore(landed)), input)).rejects.toBeInstanceOf(StoreUnavailableError);
    }
  });

  it('이벤트는 같아도 저장된 Task 가 보낸 것과 다르면 남의 발행이다 (같은 ID 가 다시 발급되고 같은 행위자·같은 시각인 경우)', async () => {
    const sameEvent = (sent: { events: NewEvent[] }) => [{ ...sent.events[0]!, seq: 1, task_id: 'T-0007' } as Event];
    const someoneElses = unknownOutcomeStore(sameEvent, (task) => ({ ...task, title: '다른 사람이 발행한 Task' }));
    const error = await createTask(context(someoneElses), input).catch((e) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect(error.cause).toBeInstanceOf(CommitOutcomeUnknownError);

    const missing = unknownOutcomeStore(sameEvent, () => undefined);
    await expect(createTask(context(missing), input)).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it('확인조차 할 수 없으면 여전히 알 수 없는 것이다 → 원래의 CommitOutcomeUnknownError', async () => {
    const eventsUnreadable = unknownOutcomeStore(() => new StoreUnavailableError('disk gone'));
    await expect(createTask(context(eventsUnreadable), input)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);

    const sameEvent = (sent: { events: NewEvent[] }) => [{ ...sent.events[0]!, seq: 1, task_id: 'T-0007' } as Event];
    const taskUnreadable = unknownOutcomeStore(sameEvent, () => new StoreUnavailableError('disk gone'));
    await expect(createTask(context(taskUnreadable), input)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
  });
});
