import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createTask } from '../../src/commands/create-task.js';
import { FileProjectCatalog } from '../../src/workspace/git/settings.js';
import { loadSchemas } from '../../src/schema/registry.mjs';
import { newStore, tempDataDir } from '../store/helpers.js';
import { repository } from './helpers.js';

describe('Workspace 설정·기준 branch', () => {
  it('원격 HEAD 변경을 조회하며 오래된 origin/HEAD·등록 기본값으로 대신하지 않는다', async () => {
    const s = repository();
    expect(await s.workspace.defaultBranch('sample')).toBe('trunk');
    const { runGit } = await import('./helpers.js');
    runGit(s.source, 'push', 'origin', 'HEAD:release');
    runGit(s.remote, 'symbolic-ref', 'HEAD', 'refs/heads/release');
    expect(await s.workspace.defaultBranch('sample')).toBe('release');
    expect(runGit(s.clone, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/trunk');
  });

  it('branch 생략은 resolver를 쓰고, 이름 지정은 remote 기본, local에는 이름이 필요하다', async () => {
    const store = newStore(tempDataDir());
    const ctx = { store, clock: { now: () => new Date() }, actor: 'human:test', baseBranches: { defaultBranch: async () => 'trunk' } };
    const definition = { title: 'g', goal: 'g', type: 'feature' as const, acceptance_criteria: [{ id: 'AC1', text: 'g' }], target: { repo: 'r' } };
    expect((await createTask(ctx, definition)).target).toMatchObject({ base_branch: 'trunk', base_source: 'remote' });
    await expect(createTask(ctx, { ...definition, target: { repo: 'r', base_source: 'local' } })).rejects.toThrow(/branch 이름/);
    for (const name of ['-bad', 'main~1', 'refs/heads/main', 'C:/repo', '../main', 'a.lock', 'a\\b']) {
      await expect(createTask(ctx, { ...definition, target: { repo: 'r', base_branch: name } })).rejects.toThrow(/branch 이름/);
    }
    const offline = { ...ctx, baseBranches: { defaultBranch: async () => { throw new Error('offline'); } } };
    await expect(createTask(offline, definition)).rejects.toThrow('offline');
    expect((await store.list('task', {})).items).toHaveLength(1);
    expect((await createTask(offline, { ...definition, target: { repo: 'r', base_branch: 'feature/a' } })).target.base_source).toBe('remote');
  });

  it('등록부/머신 설정을 검증하고 머신 설정 파일 기준으로 경로를 해석한다', async () => {
    const root = tempDataDir();
    const registry = join(root, 'projects.yaml'); const machine = join(root, 'machine.yaml');
    writeFileSync(registry, stringify({ projects: { sample: { repo: 'https://example.invalid/r.git', base_branch: 'old' } } }));
    writeFileSync(machine, stringify({ projects: { sample: { clone: 'clone', worktree_root: 'trees', remote: 'upstream' } } }));
    const catalog = new FileProjectCatalog(registry, machine);
    expect(await catalog.locate('sample')).toEqual({ url: 'https://example.invalid/r.git', clone: join(root, 'clone'), worktreeRoot: join(root, 'trees'), remote: 'upstream' });
    await expect(catalog.locate('constructor')).rejects.toThrow(/등록된 원격/);
    await expect(new FileProjectCatalog(registry).locate('sample')).rejects.toThrow(/machine-config/);
    writeFileSync(registry, stringify({ projects: { sample: { repo: root } } }));
    await expect(catalog.remoteUrl('sample')).rejects.toThrow(/로컬 경로/);
    writeFileSync(registry, 'projects: []');
    await expect(catalog.remoteUrl('sample')).rejects.toThrow(/검증/);
  });

  it('새 이벤트는 준비 기록의 필수 필드·SHA·출처를 검증하고 옛 이벤트는 계속 읽는다', () => {
    const validate = loadSchemas().validator('event');
    const event = { seq: 1, task_id: 'T-0001', type: 'workspace.prepare_requested', actor: 'system', at: '2026-09-20T00:00:00Z' };
    expect(validate(event)).toBe(false);
    expect(validate({ ...event, data: { base_sha: 'bad' } })).toBe(false);
    expect(validate({ ...event, type: 'task.created' })).toBe(true);
    expect(validate({ ...event, type: 'workspace.prepared', data: { workspace_id: 'wrong' } })).toBe(false);
  });
});
