import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWorkspace } from '../../src/commands/workspace.js';
import { getWorkspace } from '../../src/queries/workspace.js';
import { GitWorkspace } from '../../src/workspace/git/workspace.js';
import { BUILD_DIR, REPO_ROOT } from '../store/paths.js';
import { advanceRemote, setup } from './helpers.js';

describe('Workspace: 프로세스 강제 종료와 재시작', () => {
  it.each(['intent', 'git', 'complete'])('%s 경계에서 자식 프로세스를 죽인 뒤 같은 SHA·작업공간으로 이어간다', async (crashAt) => {
    const s = await setup();
    const child = spawn(process.execPath, [join(REPO_ROOT, 'tests', 'workspace', 'fixtures', 'child.mjs'), JSON.stringify({
      build: BUILD_DIR, dataDir: s.dataDir, remote: s.remote, clone: s.clone, worktreeRoot: s.worktreeRoot, taskId: s.task.id, crashAt,
    })], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${stderr}`)), 25_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('checkpoint\n')) { clearTimeout(timer); resolve(); }
        });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${stderr}`)); });
      });
      child.kill('SIGKILL');
      await exited;
      advanceRemote(s);
      const ctx = { ...s.ctx, workspace: new GitWorkspace(s.catalog) };
      const before = await getWorkspace(ctx, s.task.id);
      expect(before.state).toBe(crashAt === 'intent' ? 'pending' : crashAt === 'git' ? 'pending_record' : 'ready');
      const result = await prepareWorkspace(ctx, { taskId: s.task.id });
      expect(result.preparation.base_sha).toBe(s.initial);
      expect(result.location.head).toBe(s.initial);
      if (before.location) expect(result.location.workdir).toBe(before.location.workdir);
      expect((await ctx.store.readEvents(s.task.id)).map((e) => e.type)).toEqual(['task.created', 'workspace.prepare_requested', 'workspace.prepared']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
