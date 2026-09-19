// commands.appendEvents (T-0006 step-002, docs/design/commands.md 6.2·6.3): 다른 command 가 쓰지 않는 이벤트를 Store 의 commit 으로.
import { describe, expect, it } from 'vitest';
import { APPENDABLE_EVENT_TYPES, appendEvents, type CommandContext, RejectedInputError, recordedAt } from '../../src/commands/index.js';
import { ConflictError, SchemaViolationError, TaskNotFoundError } from '../../src/store/errors.js';
import type { ChangeInput, Store } from '../../src/store/types.js';
import { contentSnapshot, createSample, newStore, tempDataDir } from '../store/helpers.js';
import { event, run, step } from '../store/records.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clock = { now: () => new Date('2026-09-19T12:34:56.789Z') };
const context = (store: Store, overrides: Partial<CommandContext> = {}): CommandContext => ({ store, clock, actor: 'system', systemSha: 'a'.repeat(40), ...overrides });

async function setup() {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  const task = await createSample(store);
  await store.commit(task.id, {
    writes: [
      { kind: 'step', value: step(task.id, 'step-001') },
      { kind: 'run', value: run(task.id, 'R-001', { stepId: 'step-001' }) },
    ],
    events: [event('step.defined', { step_id: 'step-001' })],
  });
  return { dataDir, store, taskId: task.id };
}

describe('recordedAt — 도구가 채우는 시각', () => {
  it('초 단위 UTC 이고 밀리초를 버린다 (F-001 (3))', () => {
    expect(recordedAt(clock)).toBe('2026-09-19T12:34:56Z');
    expect(recordedAt({ now: () => new Date('2026-01-02T03:04:05.000Z') })).toBe('2026-01-02T03:04:05Z');
  });
});

describe('commands.appendEvents', () => {
  it('한 commit 으로 기록한다 — commit_id 가 붙고, actor·at(초 단위)·system_sha 는 도구가 채운다', async () => {
    const { store, taskId } = await setup();
    const written = await appendEvents(context(store), {
      taskId,
      events: [{ type: 'ledger.updated', step_id: 'step-001' }, { type: 'run.message_sent', run_id: 'R-001', data: { note: '방향 지시' } }],
    });
    expect(written).toEqual([
      { seq: 3, task_id: taskId, commit_id: expect.stringMatching(UUID), type: 'ledger.updated', actor: 'system', step_id: 'step-001', system_sha: 'a'.repeat(40), at: '2026-09-19T12:34:56Z' },
      { seq: 4, task_id: taskId, commit_id: written[0]!.commit_id, type: 'run.message_sent', actor: 'system', run_id: 'R-001', data: { note: '방향 지시' }, system_sha: 'a'.repeat(40), at: '2026-09-19T12:34:56Z' },
    ]);
    expect((await store.readEvents(taskId)).slice(2)).toEqual(written);
  });

  it('actor 는 ctx 의 것(입구의 --actor human:<id>)이다', async () => {
    const { store, taskId } = await setup();
    const [e] = await appendEvents(context(store, { actor: 'human:CheongMyungJ' }), { taskId, events: [{ type: 'task.requirement_added', data: { note: 'x' } }] });
    expect(e!.actor).toBe('human:CheongMyungJ');
  });

  it('받는 타입은 넷이다', () => {
    expect([...APPENDABLE_EVENT_TYPES]).toEqual(['ledger.updated', 'run.message_sent', 'decision.answered', 'task.requirement_added']);
  });

  const rejected: [string, unknown][] = [
    ['배열이 아니다', { type: 'ledger.updated' }],
    ['빈 배열', []],
    ['at', [{ type: 'ledger.updated', at: '2026-09-19T00:00:00Z' }]],
    ['seq', [{ type: 'ledger.updated', seq: 99 }]],
    ['task_id', [{ type: 'ledger.updated', task_id: 'T-0001' }]],
    ['commit_id', [{ type: 'ledger.updated', commit_id: '00000000-0000-0000-0000-000000000000' }]],
    ['system_sha', [{ type: 'ledger.updated', system_sha: 'abc' }]],
    ['actor', [{ type: 'ledger.updated', actor: 'system' }]],
    ['모르는 필드', [{ type: 'ledger.updated', note: 'x' }]],
    ['step.status_changed', [{ type: 'step.status_changed', step_id: 'step-001', data: { from: 'defined', to: 'running' } }]],
    ['run.submitted', [{ type: 'run.submitted', run_id: 'R-001' }]],
    ['run.completed', [{ type: 'run.completed', run_id: 'R-001' }]],
    ['run.failed', [{ type: 'run.failed', run_id: 'R-001' }]],
    ['gate.completed', [{ type: 'gate.completed', step_id: 'step-001' }]],
    ['task.done', [{ type: 'task.done' }]],
    ['task.created', [{ type: 'task.created' }]],
    ['artifact.approved', [{ type: 'artifact.approved' }]],
    ['feedback.added', [{ type: 'feedback.added' }]],
    ['step.cancelled', [{ type: 'step.cancelled', step_id: 'step-001' }]],
    ['스키마에 없는 타입', [{ type: 'ledger.rewritten' }]],
    ['허용된 것과 섞인 command 의 이벤트 — 하나라도 있으면 전부 거부', [{ type: 'ledger.updated' }, { type: 'step.status_changed', step_id: 'step-001' }]],
    ['data 가 객체가 아니다', [{ type: 'ledger.updated', data: 'x' }]],
    ['없는 Step', [{ type: 'ledger.updated', step_id: 'step-009' }]],
    ['없는 Run', [{ type: 'run.message_sent', run_id: 'R-009' }]],
    // T-0006 F-003: ref 는 isEventRef 의 모양만 — 로컬 경로와 비정규 id 는 거부
    ['ref: 드라이브 문자로 시작하는 경로', [{ type: 'ledger.updated', ref: 'C:\\data\\T-0001\\ledger.md' }]],
    ['ref: 슬래시 드라이브 경로', [{ type: 'ledger.updated', ref: 'D:/data/T-0001/ledger.md' }]],
    ['ref: 역슬래시로 시작하는 경로', [{ type: 'ledger.updated', ref: '\\\\server\\share\\x' }]],
    ['ref: 슬래시가 든 상대 경로', [{ type: 'ledger.updated', ref: 'steps/step-001/runs/R-001.yaml' }]],
    ['ref: 절대 경로', [{ type: 'ledger.updated', ref: '/home/me/ledger.md' }]],
    ['ref: 비정규 gate id', [{ type: 'ledger.updated', ref: 'G1' }]],
    ['ref: 0 채움이 틀린 id', [{ type: 'ledger.updated', ref: 'R-0001' }]],
    ['ref: 앞뒤 공백', [{ type: 'ledger.updated', ref: ' F-001 ' }]],
    ['ref: 로컬 경로가 섞인 artifact 참조', [{ type: 'ledger.updated', ref: 'artifact://T-0001/step-001/C:\\x@v1' }]],
    ['ref: 받는 것과 섞인 경로 — 하나라도 있으면 전부 거부', [{ type: 'ledger.updated', ref: 'D-001' }, { type: 'ledger.updated', ref: 'C:\\x' }]],
  ];

  it.each([
    'artifact://T-0001/step-001/plan@v1',
    'D-001',
    'F-012',
    'G-002',
    'R-001',
    'step-001',
    'T-0001',
  ])('ref 로 받는 모양은 기록한다(옛 기록의 네 모양과 발급 ID, Task id): %s', async (ref) => {
    const { store, taskId } = await setup();
    const [e] = await appendEvents(context(store), { taskId, events: [{ type: 'ledger.updated', ref }] });
    expect(e!.ref).toBe(ref);
  });

  it('ref 의 거부 문구는 받는 모양을 적는다', async () => {
    const { store, taskId } = await setup();
    const error = (await appendEvents(context(store), { taskId, events: [{ type: 'ledger.updated', ref: 'C:\\x' }] }).catch((e: unknown) => e)) as RejectedInputError;
    expect(error.reasons).toEqual([expect.stringMatching(/^events\[0\]\.ref: "C:\\\\x" 는 받는 모양이 아니다 \(artifact:\/\/<task>\/<step>\/<name>@v<N>, step-NNN·D-NNN·F-NNN·G-NNN·R-NNN/)]);
  });
  it.each(rejected)('아무것도 쓰기 전에 거부한다: %s', async (_label, events) => {
    const { dataDir, store, taskId } = await setup();
    const before = contentSnapshot(dataDir);
    await expect(appendEvents(context(store), { taskId, events: events as never })).rejects.toBeInstanceOf(RejectedInputError);
    expect(contentSnapshot(dataDir)).toEqual(before);
  });

  it('거부 문구는 입력의 위치를 적고, 까닭을 모두 모은다', async () => {
    const { store, taskId } = await setup();
    const error = await appendEvents(context(store), { taskId, events: [{ type: 'step.status_changed', at: 'x' }] as never }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RejectedInputError);
    expect((error as RejectedInputError).reasons).toEqual([
      'events[0].at: 도구가 채우는 필드다 — 입력에 두지 않는다',
      'events[0].type: step.status_changed 는 status 를 바꾸는 command 가 짝이 되는 기록과 함께 쓰는 이벤트다 — append-events 로 넣지 않는다',
    ]);
  });

  it('없는 Task 는 TaskNotFoundError 이고 아무것도 만들지 않는다', async () => {
    const { dataDir, store } = await setup();
    const before = contentSnapshot(dataDir);
    await expect(appendEvents(context(store), { taskId: 'T-0009', events: [{ type: 'ledger.updated' }] })).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(appendEvents(context(store), { taskId: '../x', events: [{ type: 'ledger.updated' }] })).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(contentSnapshot(dataDir)).toEqual(before);
  });

  it('끝난(done) Task 에는 ledger.updated 만 받는다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store, { status: 'done' });
    const before = contentSnapshot(dataDir);
    await expect(appendEvents(context(store), { taskId: task.id, events: [{ type: 'task.requirement_added' }] })).rejects.toThrow(/T-0001 는 done 다/);
    expect(contentSnapshot(dataDir)).toEqual(before);
    const [e] = await appendEvents(context(store), { taskId: task.id, events: [{ type: 'ledger.updated' }] });
    expect(e!.commit_id).toMatch(UUID);
  });

  it('스키마 위반(actor 의 모양)은 Store 의 SchemaViolationError 로 올라오고 아무것도 쓰지 않는다', async () => {
    const { dataDir, store, taskId } = await setup();
    const before = contentSnapshot(dataDir);
    await expect(appendEvents(context(store, { actor: 'someone' }), { taskId, events: [{ type: 'ledger.updated' }] })).rejects.toBeInstanceOf(SchemaViolationError);
    expect(contentSnapshot(dataDir)).toEqual(before);
  });

  it('읽은 뒤 다른 commit 이 끼어들면 다시 읽고 다시 판단한다 (commands.md 4절)', async () => {
    const { store, taskId } = await setup();
    let interfered = false;
    // 첫 commit 직전에 남의 이벤트를 하나 끼워 넣는 Store
    const racing: Store = Object.create(store, {
      commit: {
        value: async (id: string, change: ChangeInput) => {
          if (!interfered) {
            interfered = true;
            await store.commit(id, { events: [event('ledger.updated')] });
          }
          return store.commit(id, change);
        },
      },
    });
    const written = await appendEvents(context(racing), { taskId, events: [{ type: 'ledger.updated' }] });
    expect(interfered).toBe(true);
    expect(written.map((e) => e.seq)).toEqual([4]);
  });

  it('계속 끼어들면 몇 번 뒤 ConflictError 를 그대로 올린다', async () => {
    const { store, taskId } = await setup();
    const always: Store = Object.create(store, {
      commit: {
        value: async (id: string, change: ChangeInput) => {
          await store.commit(id, { events: [event('ledger.updated')] });
          return store.commit(id, change);
        },
      },
    });
    await expect(appendEvents(context(always), { taskId, events: [{ type: 'ledger.updated' }] })).rejects.toBeInstanceOf(ConflictError);
  });
});
