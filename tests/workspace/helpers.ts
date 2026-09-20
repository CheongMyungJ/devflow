import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTask } from '../../src/commands/create-task.js';
import type { WorkspaceCommandContext } from '../../src/commands/workspace.js';
import { GitWorkspace } from '../../src/workspace/git/workspace.js';
import type { ProjectCatalog } from '../../src/workspace/git/settings.js';
import { newStore, tempDataDir } from '../store/helpers.js';

export const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}).trim();

export function repository() {
  const root = tempDataDir();
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const clone = join(root, 'clone');
  const worktreeRoot = join(root, 'worktrees');
  mkdirSync(source);
  runGit(root, 'init', '--bare', '--initial-branch=trunk', remote);
  runGit(source, 'init', '--initial-branch=trunk');
  runGit(source, 'config', 'user.name', 'tester');
  runGit(source, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(source, 'tracked.txt'), 'initial\n');
  runGit(source, 'add', '.');
  runGit(source, 'commit', '-m', 'initial');
  runGit(source, 'remote', 'add', 'origin', remote);
  runGit(source, 'push', 'origin', 'trunk');
  runGit(root, 'clone', remote, clone);
  runGit(clone, 'config', 'user.name', 'tester');
  runGit(clone, 'config', 'user.email', 'test@example.invalid');
  const catalog: ProjectCatalog = {
    remoteUrl: async () => remote,
    locate: async () => ({ url: remote, clone, worktreeRoot, remote: 'origin' }),
  };
  return { root, remote, source, clone, worktreeRoot, catalog, workspace: new GitWorkspace(catalog), initial: runGit(source, 'rev-parse', 'HEAD') };
}

export async function setup(source: 'remote' | 'local' = 'remote') {
  const repo = repository();
  const dataDir = join(repo.root, 'data');
  const store = newStore(dataDir);
  const ctx: WorkspaceCommandContext = {
    store, workspace: repo.workspace, baseBranches: repo.workspace, actor: 'human:tester', clock: { now: () => new Date('2026-09-20T01:02:03Z') },
  };
  const task = await createTask(ctx, {
    title: 'workspace test', type: 'feature', goal: 'g', acceptance_criteria: [{ id: 'AC1', text: 'works' }],
    target: { repo: 'sample', base_source: source, ...(source === 'local' ? { base_branch: 'trunk' } : {}) },
  });
  return { ...repo, dataDir, ctx, store, task };
}

export function advanceRemote(repo: ReturnType<typeof repository>) {
  writeFileSync(join(repo.source, 'tracked.txt'), 'remote update\n');
  runGit(repo.source, 'add', '.');
  runGit(repo.source, 'commit', '-m', 'remote update');
  runGit(repo.source, 'push', 'origin', 'trunk');
  return runGit(repo.source, 'rev-parse', 'HEAD');
}
