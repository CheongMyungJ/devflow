// issue-task·complete-task 입구를 자식 프로세스로 실행한다 (T-0006 step-005 ①, AC8). 사람이 한 일의 입구라 --actor human:<id> 가 없으면 사용법 오류다.
// 거부는 exit 1(command 의 거부) 또는 2(사용법)이고 어느 쪽도 데이터 디렉터리를 바꾸지 않는다(contentSnapshot). 전체 흐름은 tests/task-flow.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { SHA_C, setupRound } from './commands/round-helpers.js';
import { allText, containsPath, entryRunner, validateData } from './entry-helpers.js';
import { contentSnapshot, tempDataDir } from './store/helpers.js';
import { AT, decision, event } from './store/records.js';

const entry = entryRunner('task-entries');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECONDS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
type Json = Record<string, any>;

/** 사람이 쓴 Task 정의 — 새 양식(의도의 칸 포함), 도구가 채우는 다섯이 없다. */
const definition = (over: Json = {}): Json => ({
  title: '예시 Task',
  type: 'feature',
  problem: '문제',
  goal: '목표',
  success_criteria: [{ id: 'S1', text: '성공' }],
  affected: ['누군가'],
  non_goals: ['하지 않는 것'],
  open_questions: [
    { id: 'Q1', text: '어떻게?', answered_by: 'planner_or_worker' },
    { id: 'Q2', text: '맞는가?', answered_by: 'investigation_step' },
  ],
  acceptance_criteria: [{ id: 'AC1', text: '된다', covers: ['S1'] }],
  target: { repo: 'example-project', base_branch: 'main' },
  ...over,
});

function expectUnchanged(dataDir: string, name: string, args: string[], status: number, reason: RegExp) {
  const before = contentSnapshot(dataDir);
  const r = entry.run(name, args);
  expect(r.status, `${name} ${args.join(' ')}\n${r.all}`).toBe(status);
  expect(r.stderr).toMatch(reason);
  expect(contentSnapshot(dataDir)).toEqual(before);
}

const human = ['--actor', 'human:tester'];

/** Task 하나(T-0001)가 이미 있는 데이터 디렉터리 — Store 의 내부 파일(.locks/)도 이미 있다. 빈 디렉터리에서 Store 가 거부한 발행은
 * 빈 .locks/ 를 남긴다(기록이 아니고 git 이 무시한다 — 작업 노트). 그래서 Store 까지 가는 거부는 이 디렉터리에서 "바뀌지 않음" 을 본다. */
function issuedOnce(): string {
  const dataDir = tempDataDir();
  const r = entry.run('issue-task', [dataDir, entry.file(stringify(definition()), 'task.yaml'), ...human]);
  expect(r.status, r.all).toBe(0);
  return dataDir;
}

describe('issue-task 입구 (commands.createTask)', () => {
  it('<data-dir> <definition.yaml>: task.yaml(open, 초 단위 created_at, created_by 는 사람의 id)과 task.created(actor human:<id>, data, commit_id), 경로는 기록되지 않는다, validate-data 0 failed', () => {
    const dataDir = tempDataDir();
    const file = entry.file(stringify(definition()), 'task.yaml');
    const r = entry.run('issue-task', [dataDir, file, '--slug', 'Example Slug', '--backlog', 'item 3', '--intake', 'manual (stage 0)', '--note', '경위', ...human]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(/^issued T-0001 \(open, branch task\/T-0001-example-slug\) by tester at /);
    const task = parse(readFileSync(join(dataDir, 'T-0001', 'task.yaml'), 'utf8')) as Json;
    expect(task).toEqual({
      ...definition(),
      id: 'T-0001',
      target: { ...definition()['target'], base_source: 'remote', task_branch: 'task/T-0001-example-slug' },
      status: 'open',
      created_at: expect.stringMatching(SECONDS_UTC),
      created_by: 'tester',
    });
    const events = readFileSync(join(dataDir, 'T-0001', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json);
    expect(events).toEqual([
      {
        seq: 1,
        task_id: 'T-0001',
        commit_id: expect.stringMatching(UUID),
        type: 'task.created',
        actor: 'human:tester',
        data: { backlog: 'item 3', intake: 'manual (stage 0)', note: '경위' },
        system_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        at: task['created_at'],
      },
    ]);
    expect(Math.abs(Date.now() - Date.parse(task['created_at']))).toBeLessThan(120_000);
    expect(containsPath(allText(dataDir), entry.inputs)).toBe(false);
    const v = validateData(dataDir);
    expect(v.status, v.all).toBe(0);
    expect(v.stdout).toMatch(/ 0 failed/);
  });

  it.each([
    ['id', { id: 'T-0009' }],
    ['status', { status: 'open' }],
    ['created_at', { created_at: '2026-09-20T00:00:00Z' }],
    ['created_by', { created_by: 'tester' }],
    ['target.task_branch', { target: { repo: 'example-project', base_branch: 'main', task_branch: 'task/T-0009' } }],
  ])('도구가 채우는 %s 가 정의에 있으면 exit 1 — 아무것도 쓰지 않는다', (field, over) => {
    const dataDir = tempDataDir();
    const file = entry.file(stringify(definition(over)), 'task.yaml');
    expectUnchanged(dataDir, 'issue-task', [dataDir, file, ...human], 1, new RegExp(`${field.replace('.', '\\.')}: 도구가 채우는 필드다`));
  });

  it('사람이 답할 질문이 남은 정의(answered_by 가 두 값 밖)는 exit 1 이고 오류의 위치를 보인다 — 아무것도 쓰지 않는다', () => {
    const dataDir = issuedOnce();
    const questions = [
      { id: 'Q1', text: '어떻게?', answered_by: 'planner_or_worker' },
      { id: 'Q2', text: '사람이 정할 것', answered_by: 'human' },
    ];
    const file = entry.file(stringify(definition({ open_questions: questions })), 'task.yaml');
    expectUnchanged(dataDir, 'issue-task', [dataDir, file, ...human], 1, /\/open_questions\/1\/answered_by/);
  });

  it('사용법·입력 파일의 오류: --actor 없음·사람이 아닌 actor·시각 옵션은 exit 2, 매핑이 아닌 정의·입구 옵션의 자리를 정의에 둔 것·스키마 위반·없는 파일은 exit 1 — 아무것도 쓰지 않는다', () => {
    const dataDir = issuedOnce();
    const file = entry.file(stringify(definition()), 'task.yaml');
    expectUnchanged(dataDir, 'issue-task', [dataDir, file], 2, /--actor 가 필요하다/);
    expectUnchanged(dataDir, 'issue-task', [dataDir, file, '--actor', 'system'], 2, /--actor 는 human:<id> 모양이다/);
    expectUnchanged(dataDir, 'issue-task', [dataDir, file, '--at', AT, ...human], 2, /모르는 옵션 --at/);
    expectUnchanged(dataDir, 'issue-task', [dataDir, ...human], 2, /usage: issue-task/);
    expectUnchanged(dataDir, 'issue-task', [dataDir, entry.file('- a\n- b\n', 'list.yaml'), ...human], 1, /Task 정의\(매핑\)가 아니다/);
    expectUnchanged(dataDir, 'issue-task', [dataDir, entry.file(stringify(definition({ branchSlug: 'x' })), 'task.yaml'), ...human], 1, /branchSlug: Task 정의의 칸이 아니다/);
    expectUnchanged(dataDir, 'issue-task', [dataDir, entry.file(stringify(definition({ acceptance_criteria: [] })), 'task.yaml'), ...human], 1, /SchemaViolationError[\s\S]*\/acceptance_criteria/);
    expectUnchanged(dataDir, 'issue-task', [dataDir, join(entry.inputs, 'none.yaml'), ...human], 1, /<definition\.yaml> 을 읽지 못했다/);
  });
});

/** step-001 이 status 이고 D-001(next_step)·D-002(done)가 있는 Task. */
async function withDoneDecision(status: 'closed' | 'in_review' = 'closed') {
  const round = await setupRound(status);
  await round.store.commit(round.taskId, {
    writes: [
      { kind: 'decision', value: decision(round.taskId, 'D-001') },
      {
        kind: 'decision',
        value: { id: 'D-002', task_id: round.taskId, after_step: 'step-001', action: 'done', rationale: 'AC 모두 충족.', completion: [{ ac_id: 'AC1', evidence: 'G-001' }], packet_gaps: [], created_at: AT },
      },
    ],
    events: [event('decision.made', { ref: 'D-001' }), event('decision.made', { ref: 'D-002' })],
  });
  const yaml = (rel: string) => parse(readFileSync(join(round.dataDir, round.taskId, rel), 'utf8')) as Json;
  const events = () =>
    readFileSync(join(round.dataDir, round.taskId, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Json);
  return { ...round, yaml, events };
}

/** complete-task 의 인자. over 의 값이 기본값을 바꾼다. */
const completeArgs = (dataDir: string, taskId: string, over: Record<string, string> = {}) => {
  const o = { decision: 'D-002', 'merge-sha': SHA_C, 'post-merge-check': 'ok', ...over };
  return [dataDir, taskId, ...Object.entries(o).flatMap(([k, v]) => [`--${k}`, v])];
};

describe('complete-task 입구 (commands.completeTask)', () => {
  it('task.yaml(done)과 task.done(ref·confirmed = Decision, merge, post_merge_check, note)을 한 commit 에, validate-data 0 failed. 두 번째는 거부', async () => {
    const { dataDir, taskId, yaml, events } = await withDoneDecision();
    const before = events().length;
    const r = entry.run('complete-task', [
      ...completeArgs(dataDir, taskId, { 'merge-method': 'direct merge (--no-ff)', 'post-merge-check': 'on main: ok', note: '사람이 확정' }),
      ...human,
    ]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^${taskId} done \\(confirmed D-002, merge ccccccc\\); seq`));
    expect(yaml('task.yaml').status).toBe('done');
    expect(events().slice(before)).toEqual([
      {
        seq: before + 1,
        task_id: taskId,
        commit_id: expect.stringMatching(UUID),
        type: 'task.done',
        actor: 'human:tester',
        ref: 'D-002',
        data: { confirmed: 'D-002', merge: { repo: 'r', branch: 'main', sha: SHA_C, method: 'direct merge (--no-ff)' }, post_merge_check: 'on main: ok', note: '사람이 확정' },
        system_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        at: expect.stringMatching(SECONDS_UTC),
      },
    ]);
    const v = validateData(dataDir);
    expect(v.status, v.all).toBe(0);
    expectUnchanged(dataDir, 'complete-task', [...completeArgs(dataDir, taskId), ...human], 1, /는 done 다/);
  });

  it('거부 — 닫히지 않은 Step·done 이 아닌 Decision·줄인 sha·빈 확인은 exit 1, 필수 옵션·--actor 가 없거나 task-id 모양이 틀리면 exit 2 — 아무것도 쓰지 않는다', async () => {
    const open = await withDoneDecision('in_review');
    expectUnchanged(open.dataDir, 'complete-task', [...completeArgs(open.dataDir, open.taskId), ...human], 1, /닫히지 않은 Step\(step-001 in_review\)/);
    const s = await withDoneDecision();
    expectUnchanged(s.dataDir, 'complete-task', [...completeArgs(s.dataDir, s.taskId, { decision: 'D-001' }), ...human], 1, /D-001 의 action 은 next_step/);
    expectUnchanged(s.dataDir, 'complete-task', [...completeArgs(s.dataDir, s.taskId, { 'merge-sha': 'ccccccc' }), ...human], 1, /merge\.sha/);
    expectUnchanged(s.dataDir, 'complete-task', [...completeArgs(s.dataDir, s.taskId, { 'post-merge-check': ' ' }), ...human], 1, /postMergeCheck: 비어 있다/);
    expectUnchanged(s.dataDir, 'complete-task', completeArgs(s.dataDir, s.taskId), 2, /--actor 가 필요하다/);
    expectUnchanged(s.dataDir, 'complete-task', [s.dataDir, s.taskId, '--decision', 'D-002', '--merge-sha', SHA_C, ...human], 2, /--post-merge-check 가 필요하다/);
    expectUnchanged(s.dataDir, 'complete-task', [...completeArgs(s.dataDir, 'T-12'), ...human], 2, /<task-id> 가 T-NNNN 모양이 아니다/);
    expectUnchanged(s.dataDir, 'complete-task', [...completeArgs(s.dataDir, s.taskId), '--at', AT, ...human], 2, /모르는 옵션 --at/);
  });
});
