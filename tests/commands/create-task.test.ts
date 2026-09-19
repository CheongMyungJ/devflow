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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
      { seq: 1, task_id: 'T-0001', commit_id: expect.stringMatching(UUID), type: 'task.created', actor: 'human:tester', at: '2026-09-18T01:02:03.000Z', system_sha: 'abc123' },
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

  // 의도의 칸(T-0004). 입력 타입은 생성된 Task 타입에서 나오므로 새 칸을 그대로 받는다 — 받지 못하면 typecheck 가 실패한다.
  const intent = {
    problem: '부분 취소를 해도 재고가 돌아오지 않아 품절로 잘못 표시된다',
    success_criteria: [{ id: 'S1', text: '부분 취소한 만큼 재고 화면의 수량이 늘어난다' }],
    affected: ['재고 담당자 — 수동 보정이 필요 없어진다', '정산 배치 — 재고 수량을 읽는다'],
    non_goals: ['전체 취소의 동작 변경'],
    acceptance_criteria: [
      { id: 'AC1', text: '기존 테스트가 통과한다', covers: [] },
      { id: 'AC2', text: '부분 취소 시 취소 수량만큼 재고 복원', covers: ['S1'] },
    ],
  } satisfies Partial<CreateTaskInput>;

  it('의도의 칸을 채운 입력으로 발행하면 저장된 Task 에 그 칸이 그대로 있다', async () => {
    const store = newStore(tempDataDir());
    const filled: CreateTaskInput = {
      ...input,
      ...intent,
      open_questions: [
        { id: 'Q1', text: '복원 시점을 취소 요청 때로 할지 환불 완료 때로 할지', answered_by: 'planner_or_worker' },
        { id: 'Q2', text: '정산 배치가 복원된 수량을 다시 읽는가', answered_by: 'investigation_step' },
      ],
    };
    const task = await createTask(context(store), filled);
    const { title, type, goal, target, ...newFields } = filled;
    expect(task).toMatchObject(newFields);
    expect(Object.keys(newFields).sort()).toEqual(['acceptance_criteria', 'affected', 'non_goals', 'open_questions', 'problem', 'success_criteria']);
    expect(await getTask({ store }, task.id)).toEqual(task); // 다시 읽어도 같다 — 저장된 것에 새 칸이 있다
    expect((await getTask({ store }, task.id))?.open_questions).toEqual(filled.open_questions);
  });

  it("'사람이 답함' 이 남은 열린 질문이 있으면 발행되지 않는다 — 담당자의 값만 다른 같은 입력은 발행된다", async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const withOwner = (answered_by: string) => ({ ...input, ...intent, open_questions: [{ id: 'Q1', text: '복원 시점', answered_by }] }) as CreateTaskInput;
    await expect(createTask(context(store), withOwner('human'))).rejects.toBeInstanceOf(SchemaViolationError);
    expect(await listTasks({ store })).toEqual({ tasks: [], unreadable: [] });
    expect(snapshot(dataDir)).toEqual({}); // 아무것도 남지 않았다
    expect((await createTask(context(store), withOwner('planner_or_worker'))).id).toBe('T-0001');
    expect((await createTask(context(store), withOwner('investigation_step'))).id).toBe('T-0002');
  });

  it('Store 의 오류는 바꾸지 않고 그대로 올린다 (안내가 담긴 detail 이 사용자에게 닿아야 한다)', async () => {
    const busy = new StoreBusyError('T-0001', 'pid 123 가 쥐고 있다. … 를 삭제하면 풀린다');
    const store = { createTask: () => Promise.reject(busy) } as unknown as Store;
    await expect(createTask(context(store), input)).rejects.toBe(busy);
  });
});

describe('commands.createTask: 결과를 알 수 없는 commit 의 확인 — commit 식별자로 판정한다 (docs/design/commands.md 3절, T-0005 AC3)', () => {
  const MINE = '3f2b8c1e-0a4d-4e5f-9b6a-7c8d9e0f1a2b';
  const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  type Sent = { task: Task; events: NewEvent[] };

  /**
   * createTask 가 build 를 부른 뒤 CommitOutcomeUnknownError(commitId = MINE)를 던지는 가짜 Store. landed 가 그 뒤 readEvents 가 돌려줄 내용이다.
   * 저장된 Task 를 다시 읽어 비교하던 T-0001 의 확인은 없어졌다 — get 이 불리면 테스트가 실패한다.
   */
  function unknownOutcomeStore(landed: (sent: Sent) => Event[] | Error): Store {
    let sent: Sent | undefined;
    return {
      get: async () => {
        throw new Error('createTask 의 확인은 저장된 Task 를 읽지 않는다');
      },
      createTask: async (build: (id: string) => { task: Task; events: [NewEvent, ...NewEvent[]] }) => {
        sent = build('T-0007');
        throw new CommitOutcomeUnknownError('T-0007', 1, MINE);
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
  /** 보낸 이벤트가 seq 1 부터 기록된 모양. commitId 가 없으면 식별자가 없는 옛 이벤트다. */
  const recorded = (sent: Sent, commitId: string | undefined, overrides: Partial<Event> = {}): Event[] =>
    sent.events.map((e, i) => ({ seq: 1 + i, task_id: 'T-0007', ...(commitId ? { commit_id: commitId } : {}), ...e, ...overrides }) as Event);

  it('자기 식별자의 이벤트가 그 자리에 그대로 있으면 성립한 것이다 → 보낸 Task 를 돌려준다', async () => {
    const task = await createTask(context(unknownOutcomeStore((sent) => recorded(sent, MINE))), input);
    expect(task.id).toBe('T-0007');
    expect(task.target.task_branch).toBe('task/T-0007');
  });

  it('같은 자리에 내용이 같은 다른 commit 의 이벤트가 있으면 성립하지 않은 것이다 (실패한 발행의 ID 가 다시 발급되고 같은 행위자·같은 시각)', async () => {
    let seen: Event[] = [];
    const store = unknownOutcomeStore((sent) => (seen = recorded(sent, OTHER)));
    const error = await createTask(context(store), input).catch((e) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect(error.cause).toBeInstanceOf(CommitOutcomeUnknownError);
    // 그 자리의 이벤트는 식별자만 다르고 나머지는 보낸 것과 같았다 — T-0001 의 내용 비교라면 성립으로 판정했을 상황이다
    const { commit_id, seq, task_id, ...content } = seen[0]!;
    expect(commit_id).toBe(OTHER);
    expect(content).toEqual({ type: 'task.created', actor: 'human:tester', at: '2026-09-18T01:02:03.000Z' });
  });

  it('식별자가 없는 옛 이벤트는 내용이 같아도 자기 것이 아니다', async () => {
    const error = await createTask(context(unknownOutcomeStore((sent) => recorded(sent, undefined))), input).catch((e) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
  });

  it('Task 가 없으면 성립하지 않은 것이다 → 기록 안 됨을 뜻하는 StoreUnavailableError (원래 오류가 cause)', async () => {
    const error = await createTask(context(unknownOutcomeStore(() => new TaskNotFoundError('T-0007'))), input).catch((e) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect(error.cause).toBeInstanceOf(CommitOutcomeUnknownError);
  });

  it('자기 식별자의 이벤트가 있는데 내용·자리·개수가 어긋나면 Store 의 계약이 깨진 것이다 → SchemaViolationError(read)', async () => {
    const broken: Array<(sent: Sent) => Event[]> = [
      (sent) => recorded(sent, MINE, { actor: 'human:someone-else' }), // 내용이 다르다
      (sent) => recorded(sent, MINE, { seq: 2 }), // 자리가 어긋난다
      (sent) => [...recorded(sent, MINE), { ...recorded(sent, MINE)[0]!, seq: 2 }], // 보낸 것보다 많다
    ];
    for (const landed of broken) {
      const error = await createTask(context(unknownOutcomeStore(landed)), input).catch((e) => e);
      expect(error).toBeInstanceOf(SchemaViolationError);
      expect(error.phase).toBe('read');
      expect(error.subject).toBe(`commit ${MINE} on T-0007`);
    }
  });

  it('확인조차 할 수 없으면 여전히 알 수 없는 것이다 → 원래의 CommitOutcomeUnknownError', async () => {
    const eventsUnreadable = unknownOutcomeStore(() => new StoreUnavailableError('disk gone'));
    const error = await createTask(context(eventsUnreadable), input).catch((e) => e);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error.commitId).toBe(MINE);
  });
});
