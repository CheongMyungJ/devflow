// Task 전체 흐름 (T-0006 step-005 ②, AC2·AC3·AC7): 데이터 repo 의 .gitignore 사본을 가진 임시 git 디렉터리에서 입구(자식 프로세스)만으로
// Task 발행부터 done 까지 기록한다. 손으로 쓴 yaml 이나 이벤트는 없다(테스트가 직접 쓰는 것은 .gitignore 와 입구에 주는 입력 파일뿐이고, 입력 파일은
// 데이터 디렉터리 밖에 있다). 명령마다 확인한다: step.yaml 의 status = 그 Step 의 status 를 정한 마지막 이벤트(step.status_changed 의 to,
// 없으면 step.proposed 의 proposed)이고 status 가 바뀌었으면 그 이벤트가 이 명령의 commit 에 있다, 새 이벤트 모두에 commit_id(명령 하나에 하나),
// 도구가 채운 초 단위 UTC 의 at, ref 는 isEventRef 의 모양. 끝에 task.yaml 이 done, 모든 시각(task.yaml·task.created 포함)이 초 단위, validate-data 0 failed.
// 두 번째 테스트(AC7)는 같은 디렉터리에 장애 주입으로 Store 의 내부 파일(.locks/, .pending-*/, .rollbacks)을 실제로 만든 뒤 git status 를 본다.
// Step 한 바퀴의 더 긴 변형(실패·재실행, 사람의 수정 요청, 질문)은 tests/step-round-flow.test.ts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { isEventRef } from '../src/commands/index.js';
import { isInternalPath, LOCKS_DIR, PENDING_PREFIX, ROLLBACKS_FILE } from '../src/store/file/names.mjs';
import { allText, containsPath, entryRunner, validateData } from './entry-helpers.js';
import { spawnChild } from './store/helpers.js';
import { REPO_ROOT } from './store/paths.js';
import { stepDefinition } from './store/records.js';

const entry = entryRunner('task-flow');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECONDS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA = (c: string) => c.repeat(40);
const GITIGNORE = join(REPO_ROOT, 'tests', 'fixtures', 'data-repo-gitignore', 'gitignore');
type Json = Record<string, any>;

/** 데이터 디렉터리 기준의 모든 파일(구분자 '/'), .git 은 뺀다. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (name !== '.git') walk(p);
      } else out.push(relative(dir, p).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out.sort();
}

const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8' });

/** .gitignore 사본 하나만 commit 된 임시 git 디렉터리. 흐름과 AC7 두 테스트가 같은 디렉터리를 쓰므로 tempDataDir(테스트마다 지운다)가 아니라
 * 파일 끝(afterAll)에 지운다. */
const gitDirs: string[] = [];
afterAll(() => {
  for (const dir of gitDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function gitDataDir(gitignore: string | Buffer = readFileSync(GITIGNORE)): string {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-task-flow-'));
  gitDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, '.gitignore'), gitignore);
  git(dir, ['add', '.gitignore']);
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'gitignore']);
  return dir;
}

/** git status --porcelain 의 경로들. */
const porcelain = (dir: string, extra: string[] = []) =>
  git(dir, ['status', '--porcelain', '--untracked-files=all', ...extra])
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));

describe('Task 전체 흐름 — 입구만으로, 데이터 repo 의 .gitignore 를 가진 git 디렉터리에서', () => {
  const dataDir = gitDataDir();
  const taskId = 'T-0001';
  const taskDir = join(dataDir, taskId);

  it('issue-task → Planner Run·propose-step → define-step(수정) → Worker 제출·완료(Artifact) → Reviewer → Gate fail → revising → 재작업 → Gate pass → in_review → approve-step --gate → closed → Planner 의 done → complete-task(done)', () => {
    const events = (): Json[] => readFileSync(join(taskDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json);
    const stepYaml = join(taskDir, 'steps', 'step-001', 'step.yaml');
    const stepStatus = (): string | undefined => {
      try {
        return (parse(readFileSync(stepYaml, 'utf8')) as Json).status as string;
      } catch {
        return undefined;
      }
    };
    const taskStatus = () => (parse(readFileSync(join(taskDir, 'task.yaml'), 'utf8')) as Json).status as string;
    const log: string[] = [];

    /** 입구 하나를 돌리고 이 명령이 더한 이벤트를 검사한다. 돌려주는 것은 새 이벤트. withTask 가 false 면 <task-id> 를 넣지 않는다(issue-task). */
    const run = (name: string, args: string[], expectStatus?: string, withTask = true): Json[] => {
      const before = name === 'issue-task' ? 0 : events().length;
      const statusBefore = stepStatus();
      const r = entry.run(name, withTask ? [dataDir, taskId, ...args] : [dataDir, ...args]);
      expect(r.status, `${name}\n${r.all}`).toBe(0);
      const added = events().slice(before);
      expect(added.length, name).toBeGreaterThan(0);
      // 모든 새 이벤트에 commit_id — 한 명령은 한 commit
      expect(added.every((e) => UUID.test(e.commit_id)), name).toBe(true);
      expect(new Set(added.map((e) => e.commit_id)).size, name).toBe(1);
      // 도구가 채운 초 단위 UTC 의 at, 방금의 시각. 한 명령의 이벤트는 같은 시각
      for (const e of added) {
        expect(e.at, name).toMatch(SECONDS_UTC);
        expect(Math.abs(Date.now() - Date.parse(e.at)), name).toBeLessThan(120_000);
      }
      expect(new Set(added.map((e) => e.at)).size, name).toBe(1);
      // command 가 채운 ref 도 appendEvents 의 입력과 같은 문법(F-003)
      for (const e of added) if (e.ref !== undefined) expect(isEventRef(e.ref), `${name} ref ${e.ref}`).toBe(true);
      // step.yaml 의 status = 그 Step 의 status 를 정한 마지막 이벤트, 바뀌었으면 그 이벤트가 이 명령의 commit 에 있다
      const deciding = events().filter((e) => e.step_id === 'step-001' && (e.type === 'step.status_changed' || e.type === 'step.proposed'));
      if (deciding.length) {
        const last = deciding.at(-1)!;
        expect(stepStatus(), name).toBe(last.type === 'step.proposed' ? 'proposed' : last.data.to);
        if (stepStatus() !== statusBefore) expect(added, `${name}: status 를 정한 이벤트가 같은 commit 에`).toContainEqual(last);
      } else expect(stepStatus(), name).toBeUndefined();
      if (expectStatus !== undefined) expect(stepStatus(), name).toBe(expectStatus);
      log.push(`${name}: ${added.map((e) => e.type).join(', ')} → step ${stepStatus() ?? '-'}, task ${taskStatus()}`);
      return added;
    };
    const file = (content: string, name: string) => entry.file(content, name);
    const workerOutput = (gaps: string[]) => file(JSON.stringify({ summary: '요약', packet_gaps: gaps }), 'worker-output.json');
    const reviewerOutput = (verdict: 'pass' | 'fail') =>
      file(
        JSON.stringify({
          verdict,
          checks: [{ kind: 'deterministic', name: 'test', result: verdict }],
          done_when: [{ condition: '예시 문서가 있다', met: verdict === 'pass' }],
          comments: verdict === 'fail' ? [{ severity: 'defect', class: 'A', text: '빠진 것' }] : [],
          packet_gaps: [],
        }),
        'reviewer-output.json',
      );
    const planner = ['--role', 'planner', '--access', 'read', '--backend', 'fake', '--session-path', 'new'];
    const worker = ['--step', 'step-001', '--role', 'worker', '--access', 'write', '--backend', 'fake', '--session-path', 'new'];
    const reviewer = ['--step', 'step-001', '--role', 'reviewer', '--access', 'read', '--backend', 'fake', '--session-path', 'new'];
    const complete = (runId: string, head: string) => [
      runId, '--worker-output', workerOutput([`${runId} 의 부족`]), '--work-notes', file(`# ${runId} 노트\n`, 'notes.md'),
      '--artifact', 'plan=blob:work-notes', '--artifact', `change=code:${SHA('a')}..${head}`,
    ];
    const refs = (v: number) => `artifact://${taskId}/step-001/plan@v${v},artifact://${taskId}/step-001/change@v${v}`;
    const human = ['--actor', 'human:tester'];

    // Task 발행 — 사람이 쓴 정의(도구가 채우는 다섯이 없다)
    const definition = {
      title: '흐름', type: 'feature', problem: '문제', goal: '목표', success_criteria: [{ id: 'S1', text: '성공' }],
      open_questions: [{ id: 'Q1', text: '방법', answered_by: 'planner_or_worker' }],
      acceptance_criteria: [{ id: 'AC1', text: '된다', covers: ['S1'] }], target: { repo: 'example-project', base_branch: 'main' },
    };
    const issued = run('issue-task', [file(stringify(definition), 'task.yaml'), '--slug', 'flow', '--intake', 'manual (stage 0)', ...human], undefined, false);
    expect(issued).toEqual([expect.objectContaining({ seq: 1, type: 'task.created', actor: 'human:tester', data: { intake: 'manual (stage 0)' } })]);
    expect(parse(readFileSync(join(taskDir, 'task.yaml'), 'utf8'))).toMatchObject({ id: taskId, status: 'open', created_by: 'tester', created_at: issued[0]!.at, target: { task_branch: 'task/T-0001-flow' } });

    // Planner → Step 제안 → 사람의 확정(수정 반영)
    run('submit-run', [...planner, '--expect-id', 'R-001', '--packet', file('# 패킷\n', 'packet.md')]);
    const proposal = stringify({ after_step: null, action: 'next_step', rationale: '첫 Step', next_step: { step: stepDefinition() }, packet_gaps: [] });
    expect(run('propose-step', ['R-001', file(proposal, 'R-001.output.yaml')], 'proposed').map((e) => e.type)).toEqual(['run.completed', 'decision.made', 'step.proposed']);
    const defined = run('define-step', ['step-001', '--edited', file(stringify({ ...stepDefinition(), goal: '사람이 고친 목표' }), 'edited.yaml'), ...human], 'defined');
    expect(defined[0]).toMatchObject({ type: 'step.defined', actor: 'human:tester', ref: 'D-001', data: { human_edit: true } });
    // Worker 제출·완료(Artifact meta·본문)
    run('submit-run', worker, 'running');
    expect(run('complete-run', complete('R-002', SHA('b')), 'checking').map((e) => e.type)).toEqual([
      'run.completed', 'artifact.version_added', 'artifact.version_added', 'step.status_changed',
    ]);
    // Reviewer → Gate fail → revising → 재작업 → Gate pass → in_review
    run('submit-run', reviewer, 'checking');
    run('record-gate', ['step-001', 'G-001', 'R-003', refs(1), '--output', reviewerOutput('fail')], 'revising');
    run('submit-run', worker, 'revising');
    run('complete-run', complete('R-004', SHA('c')), 'checking');
    run('submit-run', reviewer, 'checking');
    run('record-gate', ['step-001', 'G-002', 'R-005', refs(2), '--output', reviewerOutput('pass')], 'in_review');
    // 승인 → closed
    run('approve-step', ['step-001', '--gate', 'G-002', '--text', '승인.', ...human], 'closed');
    // Planner 의 done → 사람의 확정과 merge → complete-task
    run('submit-run', planner);
    const doneDecision = stringify({
      after_step: 'step-001', action: 'done', rationale: 'AC1 충족.', completion: [{ ac_id: 'AC1', evidence: 'gate://T-0001/step-001/G-002 pass' }], packet_gaps: [],
    });
    expect(run('propose-step', ['R-006', file(doneDecision, 'R-006.output.yaml')], 'closed').map((e) => e.type)).toEqual(['run.completed', 'decision.made']);
    expect(taskStatus()).toBe('open');
    const done = run('complete-task', ['--decision', 'D-002', '--merge-sha', SHA('d'), '--merge-method', 'direct merge (--no-ff)', '--post-merge-check', 'on main: tests passed', ...human], 'closed');
    expect(done).toEqual([
      expect.objectContaining({
        type: 'task.done', actor: 'human:tester', ref: 'D-002',
        data: { confirmed: 'D-002', merge: { repo: 'example-project', branch: 'main', sha: SHA('d'), method: 'direct merge (--no-ff)' }, post_merge_check: 'on main: tests passed' },
      }),
    ]);
    expect(taskStatus()).toBe('done');

    // 이 Step 의 전이 — 7절의 표에 있는 것만, 순서대로
    expect(events().filter((e) => e.type === 'step.status_changed').map((e) => `${e.data.from}→${e.data.to}`)).toEqual([
      'proposed→defined', 'defined→running', 'running→checking', 'checking→revising', 'revising→checking', 'checking→in_review', 'in_review→approved', 'approved→closed',
    ]);
    // 모든 이벤트(task.created 포함)에 commit_id, 모든 시각이 초 단위 — 엔티티의 created_at·submitted_at·ended_at 에 task.yaml 포함
    expect(events().filter((e) => !UUID.test(e.commit_id))).toEqual([]);
    expect(events().filter((e) => !SECONDS_UTC.test(e.at))).toEqual([]);
    const times: string[] = [];
    for (const rel of filesUnder(taskDir)) {
      if (!rel.endsWith('.yaml') || rel.endsWith('.output.yaml')) continue;
      for (const m of readFileSync(join(taskDir, rel), 'utf8').matchAll(/^\s*(?:created_at|submitted_at|ended_at): "?([^"\n]+)"?$/gm)) times.push(`${rel} ${m[1]}`);
    }
    expect(times.some((t) => t.startsWith('task.yaml '))).toBe(true);
    expect(times.length).toBeGreaterThan(15);
    expect(times.filter((t) => !SECONDS_UTC.test(t.split(' ')[1]!))).toEqual([]);
    // 입구가 받은 로컬 경로는 어디에도 없다
    expect(containsPath(allText(taskDir), entry.inputs)).toBe(false);
    // task branch 의 validate-data 가 0 failed
    const v = validateData(dataDir);
    expect(v.status, v.all).toBe(0);
    expect(v.stdout).toMatch(/ 0 failed/);
    expect(log).toHaveLength(16);
  }, 180_000);

  it('(AC7) Store 의 내부 파일이 실제로 있는 상태에서 git status --porcelain 에는 기록 파일만 보이고, --ignored 에는 내부 파일이 보인다', async () => {
    // 끊긴 commit: 이벤트를 붙이기 직전에 프로세스가 죽는다 → lock(.locks/<task>.lock/…)과 .pending-<token>/ 이 남는다
    const crash = async () => {
      const child = spawnChild({ dataDir, action: 'commit', taskId, count: 1, label: 'crash', crashAt: 'after-pending' });
      const exit = await child.exit;
      expect(exit.code, `${exit.stderr}\n${filesUnder(dataDir).join('\n')}`).toBe(9);
    };
    await crash();
    // 다음 접근(입구 append-events)이 죽은 lock 을 치우고 끊긴 commit 을 되돌린다 → .rollbacks 가 생긴다. 그 뒤 한 번 더 끊는다
    const ledger = entry.run('append-events', [dataDir, taskId, entry.file(JSON.stringify([{ type: 'ledger.updated' }]), 'events.json')]);
    expect(ledger.status, ledger.all).toBe(0);
    await crash();

    const all = filesUnder(dataDir);
    const internal = all.filter((rel) => isInternalPath(rel));
    const records = all.filter((rel) => !isInternalPath(rel) && rel !== '.gitignore');    // 세 모양이 모두 실제로 있다 — 헛도는 검사가 아니다
    expect(internal.filter((rel) => rel.startsWith(`${LOCKS_DIR}/`)).length, internal.join('\n')).toBeGreaterThan(0);
    expect(internal.filter((rel) => rel.startsWith(`${taskId}/${PENDING_PREFIX}`)).length, internal.join('\n')).toBeGreaterThan(0);
    expect(internal).toContain(`${taskId}/${ROLLBACKS_FILE}`);
    expect(records).toContain(`${taskId}/events.jsonl`);
    expect(records).toContain(`${taskId}/task.yaml`);

    // 기록 파일만 보인다(모두 새 파일 ??), 내부 파일은 하나도 없다
    const visible = porcelain(dataDir);
    expect(visible.map((e) => e.path).sort()).toEqual(records);
    expect(visible.every((e) => e.code === '??')).toBe(true);
    expect(visible.filter((e) => isInternalPath(e.path))).toEqual([]);
    // --ignored 에는 내부 파일이 모두 보인다(디렉터리 단위로 나올 수 있다)
    const ignored = porcelain(dataDir, ['--ignored'])
      .filter((e) => e.code === '!!')
      .map((e) => e.path);
    expect(ignored.length).toBeGreaterThan(0);
    for (const rel of internal) expect(ignored.some((p) => p === rel || (p.endsWith('/') && rel.startsWith(p))), `${rel} not in ${ignored.join(', ')}`).toBe(true);
    expect(ignored.filter((p) => !isInternalPath(p))).toEqual([]);

    // 실제 checkout 대조 명령도 이 디렉터리에서 통과한다
    const check = entry.run('check-gitignore', [dataDir]);
    expect(check.status, check.all).toBe(0);
    expect(check.stdout).toMatch(/^ok: all 5 internal paths are ignored/m);
  }, 60_000);
});

describe('check-gitignore (실제 checkout 의 .gitignore 대조 명령)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'devflow-check-gitignore-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('내부 파일을 가리지 못하는 .gitignore 면 exit 1 과 그 경로, git checkout 이 아니면 exit 2 — 어느 쪽도 파일을 쓰지 않는다', () => {
    const partial = gitDataDir('.locks/\n');
    const before = filesUnder(partial);
    const r = entry.run('check-gitignore', [partial]);
    expect(r.status, r.all).toBe(1);
    expect(r.stdout).toMatch(/^ignored {2}\.locks\/ /m);
    expect(r.stderr).toMatch(/FAIL not ignored {2}T-0001\/\.pending-0\//);
    expect(r.stderr).toMatch(/FAIL not ignored {2}T-0001\/\.rollbacks/);
    expect(r.stderr).toMatch(/3 of 5 internal paths are not ignored/);
    expect(filesUnder(partial)).toEqual(before);
    expect(git(partial, ['status', '--porcelain'])).toBe('');

    const plain = entry.run('check-gitignore', [scratch]); // OS 임시 위치의 git 밖 디렉터리
    expect(plain.status, plain.all).toBe(2);
    expect(plain.stderr).toMatch(/git checkout 이 아니다/);
    expect(entry.run('check-gitignore', []).status).toBe(2);
  });

  // G-005 A: 규칙이 맞기만 하면 무시됨으로 보던 판단이 부정 규칙과 checkout 밖 출처의 규칙에 속았다. 두 재현과 그 변형을 거부한다.
  const fixture = readFileSync(GITIGNORE, 'utf8');
  const commitAll = (dir: string) => {
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'change']);
  };
  /** check-gitignore 를 돌리고 파일·git status 가 그대로인지 본다. */
  const checkUnchanged = (dir: string) => {
    const before = filesUnder(dir);
    const status = git(dir, ['status', '--porcelain', '--untracked-files=all', '--ignored']);
    const r = entry.run('check-gitignore', [dir]);
    expect(filesUnder(dir)).toEqual(before);
    expect(git(dir, ['status', '--porcelain', '--untracked-files=all', '--ignored'])).toBe(status);
    return r;
  };

  it('부정 규칙(!.rollbacks)이 마지막으로 맞으면 — 데이터 repo 의 .gitignore 끝이든 Task 디렉터리의 .gitignore 든 — git status 에 보이는 그 경로를 무시되지 않음으로 보고 exit 1', () => {
    for (const layout of ['root', 'nested'] as const) {
      const dir = gitDataDir(layout === 'root' ? `${fixture}!.rollbacks\n` : fixture);
      mkdirSync(join(dir, 'T-0001'));
      if (layout === 'nested') {
        writeFileSync(join(dir, 'T-0001', '.gitignore'), '!.rollbacks\n');
        commitAll(dir);
      }
      writeFileSync(join(dir, 'T-0001', ROLLBACKS_FILE), '1\n'); // 실제 내부 파일
      expect(porcelain(dir).map((e) => e.path)).toContain(`T-0001/${ROLLBACKS_FILE}`); // git 은 가리지 않는다
      const r = checkUnchanged(dir);
      expect(r.status, r.all).toBe(1);
      expect(r.stderr).toMatch(/FAIL not ignored {2}T-0001\/\.rollbacks {2}\(negated by (T-0001\/)?\.gitignore:\d+:!\.rollbacks\)/);
      expect(r.stderr).toMatch(/1 of 5 internal paths are not ignored/);
      expect(r.stdout).toMatch(/^ignored {2}T-0001\/\.pending-0\/x {2}\(\.gitignore:\d+:\.pending-\*\/\)/m);
    }
  });

  it('규칙이 core.excludesFile(사용자 설정)이나 .git/info/exclude 에만 있으면 git 은 가려도 데이터 repo 의 보장이 아니므로 exit 1', () => {
    const excludes = join(scratch, 'user-excludes');
    writeFileSync(excludes, '.locks/\n.pending-*/\n.rollbacks\n');
    for (const where of ['excludesFile', 'info/exclude'] as const) {
      const dir = gitDataDir('Thumbs.db\n'); // 내부 파일의 규칙이 없는 repo .gitignore
      if (where === 'excludesFile') git(dir, ['config', 'core.excludesFile', excludes.replaceAll('\\', '/')]);
      else writeFileSync(join(dir, '.git', 'info', 'exclude'), readFileSync(excludes));
      mkdirSync(join(dir, 'T-0001'));
      writeFileSync(join(dir, 'T-0001', ROLLBACKS_FILE), '1\n');
      expect(porcelain(dir)).toEqual([]); // git status 로는 가려져 보인다 — 옛 판단이 속던 상태
      const r = checkUnchanged(dir);
      expect(r.status, r.all).toBe(1);
      expect(r.stderr).toMatch(/FAIL not ignored {2}T-0001\/\.rollbacks {2}\(.*:\d+:\.rollbacks — not a \.gitignore file/);
      expect(r.stderr).toMatch(/5 of 5 internal paths are not ignored/);
    }
  });

  it('규칙이 추적하지 않는 .gitignore 나 HEAD 와 다르게 고친 .gitignore 에만 있으면 exit 1', () => {
    const untracked = gitDataDir('Thumbs.db\n');
    mkdirSync(join(untracked, 'T-0001'));
    writeFileSync(join(untracked, 'T-0001', '.gitignore'), '.pending-*/\n.rollbacks\n');
    const u = checkUnchanged(untracked);
    expect(u.status, u.all).toBe(1);
    expect(u.stderr).toMatch(/FAIL not ignored {2}T-0001\/\.rollbacks {2}\(T-0001\/\.gitignore:2:\.rollbacks — not a tracked \.gitignore/);

    const modified = gitDataDir('Thumbs.db\n');
    writeFileSync(join(modified, '.gitignore'), fixture); // 규칙은 작업 트리에만 있다
    const m = checkUnchanged(modified);
    expect(m.status, m.all).toBe(1);
    expect(m.stderr).toMatch(/FAIL not ignored {2}\.locks\/ {2}\(\.gitignore:\d+:\.locks\/ — differs from HEAD\)/);
    expect(m.stderr).toMatch(/5 of 5 internal paths are not ignored/);
  });
});
