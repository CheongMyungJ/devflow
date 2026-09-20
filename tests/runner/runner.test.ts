import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { submitWorker, collectWorker } from '../../src/commands/worker.js';
import { getWorkerExecution } from '../../src/queries/worker.js';
import { FakeRunner } from '../../src/runner/fake/runner.js';
import { executionKey } from '../../src/runner/records.js';
import type { RunRequest } from '../../src/runner/types.js';
import { allText, containsPath } from '../entry-helpers.js';
import { runGit } from '../workspace/helpers.js';
import { tempDataDir } from '../store/helpers.js';
import { ready, spec, terminal, until } from './helpers.js';

describe('recoverable fake Worker', () => {
  it('preserves Workspace/user changes; repeated submission/collection writes one execution, artifact set and event set', async () => {
    const s = await ready();
    const workdir = s.prepared.location.workdir;
    writeFileSync(join(workdir, 'committed.txt'), 'committed');
    runGit(workdir, 'add', '.'); runGit(workdir, 'commit', '-m', 'user work');
    writeFileSync(join(workdir, 'tracked.txt'), 'unstaged');
    writeFileSync(join(workdir, 'staged.txt'), 'staged'); runGit(workdir, 'add', 'staged.txt');
    writeFileSync(join(workdir, 'untracked.txt'), 'untracked');
    const gitBefore = [runGit(workdir, 'rev-parse', 'HEAD'), runGit(workdir, 'status', '--porcelain')];
    s.input.input = spec('success', 400);
    const first = await submitWorker(s.ctx, s.input);
    expect(first.execution.state).toBe('running');
    const key = executionKey(first.run);
    const dir = join(s.runnerDir, key.taskId, key.runId, key.executionId);
    const owner = readFileSync(join(dir, 'supervisor.json'), 'utf8');
    const ctx = { ...s.ctx, runner: new FakeRunner(s.runnerDir) };
    expect((await submitWorker(ctx, s.input)).run.execution).toEqual(first.run.execution);
    expect(readFileSync(join(dir, 'supervisor.json'), 'utf8')).toBe(owner);
    await expect(submitWorker(ctx, { ...s.input, input: spec('success', 401) })).rejects.toThrow(/different input/);
    await until(() => ctx.runner.inspect(key), terminal);
    expect(JSON.parse(readFileSync(join(dir, 'worker.json'), 'utf8')).cwd).toBe(workdir);
    const collected = await collectWorker(ctx, { taskId: s.task.id, runId: 'R-001' });
    expect(collected.run.status).toBe('completed');
    const events = await s.store.readEvents(s.task.id);
    expect(events.filter((e) => e.type === 'run.submitted')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.completed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'artifact.version_added')).toHaveLength(2);
    const before = allText(s.dataDir);
    await collectWorker(ctx, { taskId: s.task.id, runId: 'R-001' });
    await submitWorker(ctx, s.input);
    expect(allText(s.dataDir)).toBe(before);
    expect(containsPath(before, s.root)).toBe(false);
    expect([runGit(workdir, 'rev-parse', 'HEAD'), runGit(workdir, 'status', '--porcelain')]).toEqual(gitBefore);
    expect(readFileSync(join(workdir, 'tracked.txt'), 'utf8')).toBe('unstaged');
  });

  it.each([
    ['fail', '{"summary":"ignored"}', 'process_exit'],
    ['crash', '', 'process_exit'],
    ['success', '{"summary":"missing packet_gaps"}', 'invalid_output'],
    ['success', 'not JSON', 'invalid_output'],
    ['missing_output', '', 'invalid_output'],
  ])('%s / %s: confirmed process failure and invalid output remain distinct', async (mode, output, kind) => {
    const s = await ready();
    const first = await submitWorker(s.ctx, { ...s.input, input: spec(mode, 0, output) });
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    expect((await getWorkerExecution(s.ctx, s.input)).execution).toMatchObject({ state: 'failed', kind });
    const result = await collectWorker(s.ctx, { taskId: s.task.id, runId: 'R-001' });
    expect(result.run).toMatchObject({ status: 'failed', failure_kind: kind });
    const before = allText(s.dataDir);
    await collectWorker(s.ctx, { taskId: s.task.id, runId: 'R-001' });
    expect(allText(s.dataDir)).toBe(before);
    expect((await s.store.list('artifact', { taskId: s.task.id })).items).toHaveLength(0);
  });

  it('missing local evidence / launch without acknowledgement is unknown; no replacement or failure event', async () => {
    const s = await ready();
    const original = s.runner.submit.bind(s.runner);
    s.runner.submit = async () => { throw new Error('stop after shared submission'); };
    await expect(submitWorker(s.ctx, s.input)).rejects.toThrow(/stop after shared/);
    const run = (await s.store.get('run', { taskId: s.task.id, id: 'R-001' }))!;
    const key = executionKey(run);
    const other = { ...s.ctx, runner: new FakeRunner(join(s.root, 'other-machine')) };
    expect((await submitWorker(other, s.input)).execution.state).toBe('unknown');
    const dir = join(s.runnerDir, key.taskId, key.runId, key.executionId);
    mkdirSync(join(dir, 'launch-claim'));
    s.runner.submit = original;
    const before = allText(s.dataDir);
    expect((await submitWorker(s.ctx, s.input)).execution.state).toBe('unknown');
    expect((await collectWorker(s.ctx, { taskId: s.task.id, runId: 'R-001' })).execution.state).toBe('unknown');
    expect(allText(s.dataDir)).toBe(before);
    expect((await s.runner.inspect(key))).toMatchObject({ state: 'unknown', action: expect.stringContaining('새 Run') });
  });

  it('Task-scoped R-001 identities, duplicate/overlapping submission, and unsupported capabilities', async () => {
    const root = tempDataDir();
    const workdir = join(root, 'work'); mkdirSync(workdir);
    const runner = new FakeRunner(join(root, 'runner'));
    const req = (taskId: string): RunRequest => ({ key: { taskId, runId: 'R-001', executionId: randomUUID() },
      workspaceId: randomUUID(), workdir, role: 'worker', access: 'write', prompt: spec('success', 150).prompt });
    const a = req('T-0001'); const b = req('T-0002');
    await runner.prepare(a); await runner.prepare(b);
    const overlap = await Promise.allSettled([runner.submit(a), runner.submit(a), runner.submit(b)]);
    expect(overlap.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(2);
    await until(() => runner.inspect(a.key), terminal); await until(() => runner.inspect(b.key), terminal);
    const pid = (r: RunRequest) => JSON.parse(readFileSync(join(root, 'runner', r.key.taskId, 'R-001', r.key.executionId, 'worker.json'), 'utf8')).pid;
    expect(pid(a)).not.toBe(pid(b));
    await expect(runner.prepare({ ...a, prompt: spec('fail').prompt })).rejects.toThrow(/different input/);
    await expect(runner.prepare({ ...req('T-0003'), access: 'read' })).rejects.toThrow(/unsupported/);
    await expect(runner.prepare({ ...req('T-0003'), resume: { backendSessionId: 'old' } } as RunRequest)).rejects.toThrow(/unsupported option/);
    expect(Object.values(runner.capabilities)).toEqual([false, false, false, false]);
    // A PID alone, including this live test process, must never prove execution liveness.
    const c = req('T-0003'); await runner.prepare(c);
    const dir = join(root, 'runner', c.key.taskId, c.key.runId, c.key.executionId);
    mkdirSync(join(dir, 'launch-claim'));
    writeFileSync(join(dir, 'supervisor.json'), JSON.stringify({ pid: process.pid, port: 1, executionId: c.key.executionId }));
    expect((await runner.inspect(c.key)).state).toBe('unknown');
    writeFileSync(join(dir, 'result.json'), 'null');
    expect((await runner.inspect(c.key))).toMatchObject({ state: 'unknown', reason: 'invalid terminal receipt' });
  });

  it('supervisor death after output but before exit receipt remains unknown; never starts a replacement', async () => {
    const root = tempDataDir();
    const workdir = join(root, 'work'); mkdirSync(workdir);
    const runner = new FakeRunner(join(root, 'runner'));
    const request: RunRequest = { key: { taskId: 'T-0001', runId: 'R-001', executionId: randomUUID() },
      workspaceId: randomUUID(), workdir, role: 'worker', access: 'write', prompt: spec('output_then_wait', 1500).prompt };
    await runner.prepare(request); await runner.submit(request);
    const dir = join(root, 'runner', 'T-0001', 'R-001', request.key.executionId);
    await until(async () => existsSync(join(dir, 'output.json')), Boolean);
    const owner = JSON.parse(readFileSync(join(dir, 'supervisor.json'), 'utf8')) as { pid: number };
    const worker = readFileSync(join(dir, 'worker.json'), 'utf8');
    process.kill(owner.pid, 'SIGKILL');
    await until(() => runner.inspect(request.key), (s) => s.state === 'unknown');
    expect(existsSync(join(dir, 'output.json'))).toBe(true);
    expect((await runner.submit(request)).state).toBe('unknown');
    expect(readFileSync(join(dir, 'worker.json'), 'utf8')).toBe(worker);
    expect(existsSync(join(dir, 'result.json'))).toBe(false);
    // On POSIX the orphan can finish independently; Windows may terminate it with its console.
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
});
