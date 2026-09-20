import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { entryRunner, allText, containsPath } from '../entry-helpers.js';
import { repository, runGit } from './helpers.js';

const entry = entryRunner('workspace');

describe('Workspace 운영 입구', () => {
  it('설정 → issue-task → prepare-workspace → workspace-status → 재호출을 실제 프로세스로 실행한다', () => {
    const s = repository();
    const data = join(s.root, 'data'); mkdirSync(data);
    const url = 'https://example.invalid/sample.git';
    // 등록부의 공유 URL과 머신 경로를 분리하고 네트워크 없이 Git transport를 검증한다.
    runGit(s.clone, 'remote', 'set-url', 'origin', url);
    runGit(s.clone, 'config', `url.${s.remote.replaceAll('\\', '/')}.insteadOf`, url);
    writeFileSync(join(data, 'projects.yaml'), stringify({ projects: { sample: { repo: url, base_branch: 'ignored' } } }));
    const machine = join(s.root, 'machine.yaml');
    writeFileSync(machine, stringify({ projects: { sample: { clone: 'clone', worktree_root: 'worktrees' } } }));
    const definition = join(s.root, 'task.yaml');
    writeFileSync(definition, stringify({ title: 'entry', type: 'feature', goal: 'g', acceptance_criteria: [{ id: 'AC1', text: 'g' }], target: { repo: 'sample', base_branch: 'trunk' } }));
    const issued = entry.run('issue-task', [data, definition, '--actor', 'human:tester']);
    expect(issued.status, issued.all).toBe(0);
    const args = [data, 'T-0001', '--machine-config', machine];
    const first = entry.run('prepare-workspace', args);
    expect(first.status, first.all).toBe(0);
    expect(first.stdout).toContain('remote:trunk@');
    const status = entry.run('workspace-status', args);
    expect(status.status, status.all).toBe(0);
    const workspace = JSON.parse(status.stdout) as { state: string; location: { workdir: string } };
    expect(workspace.state).toBe('ready');
    writeFileSync(join(workspace.location.workdir, 'keep.txt'), 'keep');
    const before = allText(data);
    const second = entry.run('prepare-workspace', args);
    expect(second.status, second.all).toBe(0);
    expect(second.stdout).toContain('uncommitted changes preserved');
    expect(readFileSync(join(workspace.location.workdir, 'keep.txt'), 'utf8')).toBe('keep');
    expect(allText(data)).toBe(before);
    expect(containsPath(before, s.root)).toBe(false);
    // 잠금 충돌은 변경 없음이라고 거짓 보고하지 않는다.
    const admin = join(s.clone, '.git', 'devflow-workspaces');
    writeFileSync(join(admin, 'prepare.lock'), 'owner');
    const blocked = entry.run('prepare-workspace', args);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('준비 기록 또는 Git 작업이 남아 있을 수 있다');
    expect(blocked.stderr).not.toContain('아무것도 기록하지 않았다');
  });
});
