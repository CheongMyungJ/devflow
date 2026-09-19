// commands.completeTask (T-0006 step-005 ①, AC8): task.yaml 의 done 과 task.done 을 한 commit 에. 거부는 아무것도 쓰기 전에(contentSnapshot).
import { describe, expect, it } from 'vitest';
import { completeTask, type CompleteTaskInput } from '../../src/commands/index.js';
import { TaskNotFoundError } from '../../src/store/errors.js';
import type { Decision, Step } from '../../src/types/generated/index.js';
import { AT, decision, event } from '../store/records.js';
import { ctxOf, expectRejected, NOW_SECONDS, SHA_A, SHA_C, setupRound } from './round-helpers.js';

const doneDecision = (taskId: string, id: string): Decision => ({ id, task_id: taskId, after_step: 'step-001', action: 'done', rationale: 'AC 모두 충족.', completion: [{ ac_id: 'AC1', evidence: 'G-001 pass' }], packet_gaps: [], created_at: AT });

/** step-001 이 status 이고 D-001(next_step)·D-002(done)가 있는 Task. */
async function setupDone(status: Step['status'] = 'closed') {
  const round = await setupRound(status);
  await round.store.commit(round.taskId, {
    writes: [
      { kind: 'decision', value: decision(round.taskId, 'D-001') },
      { kind: 'decision', value: doneDecision(round.taskId, 'D-002') },
    ],
    events: [event('decision.made', { ref: 'D-001' }), event('decision.made', { ref: 'D-002' })],
  });
  const input = (over: Partial<CompleteTaskInput> = {}): CompleteTaskInput => ({
    taskId: round.taskId,
    decisionId: 'D-002',
    merge: { sha: SHA_C, method: 'direct merge (--no-ff)' },
    postMergeCheck: 'on main: typecheck ok, tests passed',
    ...over,
  });
  return { ...round, input };
}

describe('commands.completeTask', () => {
  it('task.yaml(done)과 task.done(ref·data.confirmed = Decision, data.merge{repo, branch, sha, method}, data.post_merge_check, data.note)을 한 commit 에 쓴다', async () => {
    const { store, taskId, human, input } = await setupDone();
    const before = (await store.readEvents(taskId)).length;
    const { task, result } = await completeTask(human, input({ note: '사람이 done 을 확정했다' }));
    expect(task.status).toBe('done');
    expect(await store.get('task', { taskId })).toEqual(task);
    const added = (await store.readEvents(taskId)).slice(before);
    expect(added).toHaveLength(1);
    const { seq, task_id, commit_id, ...rest } = added[0]!;
    expect(commit_id).toBe(result.commitId);
    // 옛 기록(T-0003~T-0005 의 task.done)과 같은 모양 — repo·branch 는 Task 의 target 에서
    expect(rest).toEqual({
      type: 'task.done',
      actor: 'human:tester',
      ref: 'D-002',
      data: { confirmed: 'D-002', merge: { repo: 'r', branch: 'main', sha: SHA_C, method: 'direct merge (--no-ff)' }, post_merge_check: 'on main: typecheck ok, tests passed', note: '사람이 done 을 확정했다' },
      system_sha: SHA_A,
      at: NOW_SECONDS,
    });
    expect(Object.keys(rest)).toEqual(['type', 'actor', 'ref', 'data', 'system_sha', 'at']);
  });

  it('merge.method 와 note 가 없으면 data 에 두지 않는다. cancelled 인 Step 은 닫힌 것이다', async () => {
    const { store, taskId, human, input } = await setupDone('cancelled');
    await completeTask(human, input({ merge: { sha: 'd'.repeat(64) } }));
    const last = (await store.readEvents(taskId)).at(-1)!;
    expect(last.data).toEqual({ confirmed: 'D-002', merge: { repo: 'r', branch: 'main', sha: 'd'.repeat(64) }, post_merge_check: 'on main: typecheck ok, tests passed' });
  });

  const cases: Array<[string, (s: Awaited<ReturnType<typeof setupDone>>) => Promise<unknown>, RegExp]> = [
    ['사람이 아닌 actor', (s) => completeTask(s.sys, s.input()), /actor: 사람이 한 일은 human:<id>/],
    ['Decision 이 action done 이 아니다', (s) => completeTask(s.human, s.input({ decisionId: 'D-001' })), /D-001 의 action 은 next_step/],
    ['없는 Decision', (s) => completeTask(s.human, s.input({ decisionId: 'D-009' })), /D-009 가 없다/],
    ['Decision id 가 정규형이 아니다', (s) => completeTask(s.human, s.input({ decisionId: 'D2' })), /decisionId: "D2" 는 D-NNN/],
    ['줄인 merge sha', (s) => completeTask(s.human, s.input({ merge: { sha: 'abc1234' } })), /merge\.sha: "abc1234"/],
    ['대문자 merge sha', (s) => completeTask(s.human, s.input({ merge: { sha: 'C'.repeat(40) } })), /merge\.sha/],
    ['41자 merge sha', (s) => completeTask(s.human, s.input({ merge: { sha: 'c'.repeat(41) } })), /merge\.sha/],
    ['빈 post_merge_check', (s) => completeTask(s.human, s.input({ postMergeCheck: '  ' })), /postMergeCheck: 비어 있다/],
    ['빈 merge.method', (s) => completeTask(s.human, s.input({ merge: { sha: SHA_C, method: '' } })), /merge\.method: 비어 있다/],
    ['도구가 채우는 필드(at)', (s) => completeTask(s.human, { ...s.input(), at: NOW_SECONDS } as never), /at: 도구가 채우는 필드다/],
    ['도구가 채우는 필드(status)', (s) => completeTask(s.human, { ...s.input(), status: 'done' } as never), /status: 도구가 채우는 필드다/],
    ['merge 의 모르는 필드(repo — 도구가 Task 에서 채운다)', (s) => completeTask(s.human, s.input({ merge: { sha: SHA_C, repo: 'x' } as never })), /merge\.repo: 모르는 입력이다/],
    ['모르는 필드', (s) => completeTask(s.human, { ...s.input(), mergedAt: 'x' } as never), /mergedAt: 모르는 입력이다/],
  ];
  it.each(cases)('거부 — %s: 아무것도 쓰지 않는다', async (_label, work, message) => {
    const s = await setupDone();
    expect(await expectRejected(s.dataDir, () => work(s))).toMatch(message);
  });

  it.each(['proposed', 'defined', 'running', 'checking', 'in_review', 'revising', 'approved'] as const)('거부 — 닫히지 않은 Step(%s)이 있다', async (status) => {
    const s = await setupDone(status);
    expect(await expectRejected(s.dataDir, () => completeTask(s.human, s.input()))).toContain(`닫히지 않은 Step(step-001 ${status})`);
  });

  it('거부 — Task 가 open 이 아니다(이미 done): 두 번째 complete 는 아무것도 쓰지 않는다', async () => {
    const s = await setupDone();
    await completeTask(s.human, s.input());
    expect(await expectRejected(s.dataDir, () => completeTask(s.human, s.input()))).toMatch(/Task T-\d+ 는 done 다/);
  });

  it('없는 Task 는 TaskNotFoundError — 아무것도 쓰지 않는다', async () => {
    const s = await setupDone();
    await expectRejected(s.dataDir, () => completeTask(ctxOf(s.store, 'human:tester'), s.input({ taskId: 'T-0404' })), TaskNotFoundError);
  });
});
