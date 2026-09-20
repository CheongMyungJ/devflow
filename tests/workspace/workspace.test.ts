import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWorkspace } from '../../src/commands/workspace.js';
import { getWorkspace } from '../../src/queries/workspace.js';
import { createTask } from '../../src/commands/create-task.js';
import { GitWorkspace } from '../../src/workspace/git/workspace.js';
import type { Workspace } from '../../src/workspace/types.js';
import { CommitOutcomeUnknownError } from '../../src/store/errors.js';
import { allText, containsPath } from '../entry-helpers.js';
import { advanceRemote, repository, runGit, setup } from './helpers.js';

describe('Workspace: 실제 Git 저장소', () => {
  it('원격 HEAD로 branch를 발행하고 최초 준비 때 fetch한 최신 SHA로 만든다', async () => {
    const s = await setup();
    expect(s.task.target).toMatchObject({ base_branch: 'trunk', base_source: 'remote' });
    const newest = advanceRemote(s);
    expect(runGit(s.clone, 'rev-parse', 'trunk')).toBe(s.initial);
    const result = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    expect(result.preparation.base_sha).toBe(newest);
    expect(result.location.head).toBe(newest);
    expect(runGit(result.location.workdir, 'branch', '--show-current')).toBe(s.task.target.task_branch);
    expect(runGit(s.clone, 'rev-parse', 'trunk')).toBe(s.initial); // 로컬 branch는 움직이지 않음
    expect((await getWorkspace(s.ctx, s.task.id)).state).toBe('ready');
    const text = allText(s.dataDir);
    expect(containsPath(text, s.root)).toBe(false);
    expect((await s.store.readEvents(s.task.id)).map((e) => e.type)).toEqual(['task.created', 'workspace.prepare_requested', 'workspace.prepared']);
  });

  it('branch 이름만 주면 remote로 기록하고, local은 로컬 branch의 SHA를 사용한다', async () => {
    const s = await setup('local');
    advanceRemote(s);
    const result = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    expect(result.location.head).toBe(s.initial);
    const other = await createTask(s.ctx, {
      title: 'named', type: 'feature', goal: 'g', acceptance_criteria: [{ id: 'AC1', text: 'g' }],
      target: { repo: 'sample', base_branch: 'trunk' },
    });
    expect(other.target.base_source).toBe('remote');
    expect((await prepareWorkspace(s.ctx, { taskId: other.id })).location.head).not.toBe(s.initial);
  });

  it('재호출·새 인스턴스에서 commit과 staged/unstaged/untracked 변경을 보존하고 이벤트를 늘리지 않는다', async () => {
    const s = await setup();
    const first = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    const dir = first.location.workdir;
    writeFileSync(join(dir, 'committed.txt'), 'committed');
    runGit(dir, 'add', '.'); runGit(dir, 'commit', '-m', 'work');
    writeFileSync(join(dir, 'staged.txt'), 'stage'); runGit(dir, 'add', 'staged.txt');
    writeFileSync(join(dir, 'tracked.txt'), 'unstaged');
    writeFileSync(join(dir, 'untracked.txt'), 'untracked');
    const head = runGit(dir, 'rev-parse', 'HEAD');
    const status = runGit(dir, 'status', '--porcelain');
    const events = await s.store.readEvents(s.task.id);
    advanceRemote(s);
    const second = await prepareWorkspace({ ...s.ctx, workspace: new GitWorkspace(s.catalog) }, { taskId: s.task.id });
    expect(second.location).toEqual({ workdir: dir, head, dirty: true });
    expect(second.preparation).toEqual(first.preparation);
    expect(runGit(dir, 'status', '--porcelain')).toBe(status);
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('unstaged');
    expect(await s.store.readEvents(s.task.id)).toEqual(events);
  });

  it('원격 fetch 실패를 로컬/오래된 추적 branch로 대체하지 않고 준비 기록도 남기지 않는다', async () => {
    const s = await setup();
    runGit(s.source, 'push', 'origin', 'HEAD:temporary');
    const task = await createTask(s.ctx, {
      title: 'gone', type: 'feature', goal: 'g', acceptance_criteria: [{ id: 'AC1', text: 'g' }], target: { repo: 'sample', base_branch: 'temporary' },
    });
    runGit(s.clone, 'fetch', 'origin');
    runGit(s.source, 'push', 'origin', '--delete', 'temporary');
    await expect(prepareWorkspace(s.ctx, { taskId: task.id })).rejects.toMatchObject({ phase: 'before_start' });
    expect((await s.store.readEvents(task.id)).map((e) => e.type)).toEqual(['task.created']);
  });

  it('Git 생성 성공 뒤 완료 commit 실패 시 실제 작업공간을 재사용한다', async () => {
    const s = await setup();
    const commit = s.store.commit.bind(s.store);
    s.store.commit = async (id, change) => {
      if (typeof change !== 'function' && change.events[0].type === 'workspace.prepared') throw new Error('injected completion failure');
      return commit(id, change);
    };
    await expect(prepareWorkspace(s.ctx, { taskId: s.task.id })).rejects.toMatchObject({ phase: 'interrupted' });
    const pending = await getWorkspace(s.ctx, s.task.id);
    expect(pending.state).toBe('pending_record');
    s.store.commit = commit;
    const recovered = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    expect(recovered.location.workdir).toBe(pending.location?.workdir);
    expect((await s.store.readEvents(s.task.id)).filter((e) => e.type === 'workspace.prepared')).toHaveLength(1);
  });

  it('준비 의도 뒤 중단되면 base branch가 움직여도 고정한 SHA로 계속한다', async () => {
    const s = await setup();
    const workspace: Workspace = {
      defaultBranch: (r) => s.workspace.defaultBranch(r), resolveBase: (t) => s.workspace.resolveBase(t),
      inspect: (p) => s.workspace.inspect(p), ensure: async () => { throw new Error('stopped before Git'); },
    };
    await expect(prepareWorkspace({ ...s.ctx, workspace }, { taskId: s.task.id })).rejects.toMatchObject({ phase: 'interrupted' });
    expect((await getWorkspace(s.ctx, s.task.id)).state).toBe('pending');
    advanceRemote(s);
    const result = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    expect(result.location.head).toBe(s.initial);
  });

  it('이미 존재하는 Task branch와 다른 worktree를 채택하거나 수정하지 않는다', async () => {
    const s = await setup();
    const unrelated = join(s.root, 'unrelated');
    runGit(s.clone, 'worktree', 'add', '-b', s.task.target.task_branch, unrelated, 'trunk');
    writeFileSync(join(unrelated, 'precious.txt'), 'keep');
    await expect(prepareWorkspace(s.ctx, { taskId: s.task.id })).rejects.toMatchObject({ phase: 'before_start' });
    expect(readFileSync(join(unrelated, 'precious.txt'), 'utf8')).toBe('keep');
    expect((await s.store.readEvents(s.task.id))).toHaveLength(1);
  });

  it('다른 branch로 바뀐 준비 완료 작업공간은 덮어쓰지 않는다', async () => {
    const s = await setup();
    const result = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    runGit(result.location.workdir, 'switch', '-c', 'someone-else');
    await expect(prepareWorkspace(s.ctx, { taskId: s.task.id })).rejects.toMatchObject({ phase: 'interrupted' });
    expect((await getWorkspace(s.ctx, s.task.id)).state).toBe('blocked');
    expect(runGit(result.location.workdir, 'branch', '--show-current')).toBe('someone-else');
  });

  it('겹친 실행/남은 잠금은 즉시 중단하며 잠금을 자동 회수하지 않는다', async () => {
    const s = await setup();
    const lock = join(s.clone, '.git', 'devflow-workspaces', 'prepare.lock');
    mkdirSync(join(s.clone, '.git', 'devflow-workspaces'));
    writeFileSync(lock, 'another owner');
    await expect(prepareWorkspace(s.ctx, { taskId: s.task.id })).rejects.toMatchObject({ phase: 'interrupted', cause: { code: 'busy' } });
    expect(readFileSync(lock, 'utf8')).toBe('another owner');
    expect((await getWorkspace(s.ctx, s.task.id)).state).toBe('blocked');
  });

  it('두 준비 호출이 겹치면 적어도 하나는 중단하고 중복 요청/작업공간을 만들지 않는다', async () => {
    const s = await setup();
    const results = await Promise.allSettled([prepareWorkspace(s.ctx, { taskId: s.task.id }), prepareWorkspace(s.ctx, { taskId: s.task.id })]);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    const result = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    expect(result.location.head).toBe(s.initial);
    expect(readdirSync(s.worktreeRoot)).toHaveLength(1);
    expect((await s.store.readEvents(s.task.id)).filter((e) => e.type === 'workspace.prepare_requested')).toHaveLength(1);
  });

  it('잘못된 clone/등록 URL과 옛 Task의 출처 미확정을 거부한다', async () => {
    const s = await setup();
    const other = repository();
    const wrong = new GitWorkspace({ remoteUrl: async () => s.remote, locate: async () => ({ url: s.remote, clone: other.clone, worktreeRoot: s.worktreeRoot, remote: 'origin' }) });
    await expect(prepareWorkspace({ ...s.ctx, workspace: wrong }, { taskId: s.task.id })).rejects.toMatchObject({ phase: 'before_start', cause: { code: 'configuration' } });
    const { base_source, ...target } = s.task.target;
    await s.store.commit(s.task.id, { writes: [{ kind: 'task', value: { ...s.task, target } }], events: [{ type: 'task.requirement_added', actor: 'system', at: s.task.created_at }] });
    await expect(prepareWorkspace(s.ctx, { taskId: s.task.id })).rejects.toThrow(/base_source/);
  });

  it('부분 checkout 가능성이 있는 worktree를 완료로 인정하지 않고 파일을 보존한다', async () => {
    const s = await setup();
    const result = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    const admin = join(s.clone, '.git', 'devflow-workspaces');
    const marker = readdirSync(admin).find((name) => name.endsWith('.ready'))!;
    unlinkSync(join(admin, marker));
    writeFileSync(join(result.location.workdir, 'keep.txt'), 'precious');
    const before = await s.store.readEvents(s.task.id);
    const state = await getWorkspace(s.ctx, s.task.id);
    expect(state.state).toBe('blocked');
    expect(state.reason).toMatch(/부분 checkout/);
    await expect(prepareWorkspace(s.ctx, { taskId: s.task.id })).rejects.toThrow(/부분 checkout/);
    expect(readFileSync(join(result.location.workdir, 'keep.txt'), 'utf8')).toBe('precious');
    expect(await s.store.readEvents(s.task.id)).toEqual(before);
  });

  it('의도/완료 commit 응답이 유실되면 commit 식별자로 확인하고 중복 없이 끝낸다', async () => {
    const s = await setup();
    const commit = s.store.commit.bind(s.store);
    s.store.commit = async (id, change) => {
      const result = await commit(id, change);
      throw new CommitOutcomeUnknownError(id, result.events[0]!.seq, result.commitId);
    };
    const result = await prepareWorkspace(s.ctx, { taskId: s.task.id });
    expect(result.location.head).toBe(s.initial);
    expect((await s.store.readEvents(s.task.id)).map((e) => e.type)).toEqual(['task.created', 'workspace.prepare_requested', 'workspace.prepared']);
  });
});
