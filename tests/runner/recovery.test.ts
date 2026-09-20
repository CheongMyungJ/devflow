import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { submitWorker, collectWorker } from '../../src/commands/worker.js';
import { getWorkerExecution } from '../../src/queries/worker.js';
import { executionKey } from '../../src/runner/records.js';
import { FakeRunner } from '../../src/runner/fake/runner.js';
import { newStore } from '../store/helpers.js';
import { BUILD_DIR, REPO_ROOT } from '../store/paths.js';
import { allText } from '../entry-helpers.js';
import { ready, spec, terminal, until } from './helpers.js';

describe('actual caller termination and recovery', () => {
  it.each(['submitted', 'running', 'before-complete', 'after-complete'])('%s: SIGKILL then new Store/Runner retrieves same execution', async (phase) => {
    const s = await ready();
    s.input.input = spec('success', phase === 'running' ? 2200 : 0);
    if (phase.includes('complete')) {
      const first = await submitWorker(s.ctx, s.input);
      await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    }
    const child = spawn(process.execPath, [join(REPO_ROOT, 'tests/runner/fixtures/caller.mjs'), JSON.stringify({
      build: BUILD_DIR, dataDir: s.dataDir, runnerDir: s.runnerDir, remote: s.remote, clone: s.clone,
      worktreeRoot: s.worktreeRoot, input: s.input, phase,
    })], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    let stderr = ''; child.stderr.on('data', (c: Buffer) => { stderr += c; });
    try {
      await new Promise<void>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(`checkpoint timeout ${stderr}`)), 15000);
        child.stdout.on('data', (c: Buffer) => { text += c; if (text.includes('checkpoint')) { clearTimeout(timer); resolve(); } });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`early exit ${code}: ${stderr}`)); });
      });
      child.kill('SIGKILL'); await exited;
      const ctx = { ...s.ctx, store: newStore(s.dataDir), runner: new FakeRunner(s.runnerDir) };
      const before = await getWorkerExecution(ctx, s.input);
      if (phase === 'running') expect(before.execution.state).toBe('running');
      if (phase === 'submitted') expect(before.execution.state).toBe('prepared');
      const resumed = await submitWorker(ctx, s.input);
      expect(resumed.run.execution).toEqual(before.run.execution);
      if (!resumed.collected) await until(() => ctx.runner.inspect(executionKey(resumed.run)), terminal);
      const collected = await collectWorker(ctx, { taskId: s.task.id, runId: 'R-001' });
      expect(collected.run.status).toBe('completed');
      const data = allText(s.dataDir);
      await collectWorker(ctx, { taskId: s.task.id, runId: 'R-001' });
      expect(allText(s.dataDir)).toBe(data);
      const events = await ctx.store.readEvents(s.task.id);
      expect(events.filter((e) => e.type === 'run.submitted')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'run.completed')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'artifact.version_added')).toHaveLength(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
