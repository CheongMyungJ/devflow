import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { submitRole, collectExecution } from '../../src/commands/roles.js';
import { submitWorker } from '../../src/commands/worker.js';
import { cancelExecution, sendExecutionMessage } from '../../src/commands/execution-control.js';
import { getExecution } from '../../src/queries/execution.js';
import { executionKey } from '../../src/runner/records.js';
import { ready, spec, terminal, until } from './helpers.js';
import { workerRound, reviewerOutput } from '../commands/round-helpers.js';
import { event, step } from '../store/records.js';
import { blobRef } from '../../src/store/blob-ref.js';

describe('managed roles and control', () => {
  it('Planner produces a Decision with one idempotent collection, without acting on it', async () => {
    const s = await ready();
    const output = JSON.stringify({ after_step: null, action: 'ask_human', rationale: 'Need a decision', question: { text: 'Which scope?' }, packet_gaps: [] });
    const input = { taskId: s.task.id, runId: 'R-001', role: 'planner' as const, input: { prompt: spec('success', 0, output).prompt } };
    const first = await submitRole(s.ctx, input);
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    const done = await collectExecution(s.ctx, { taskId: s.task.id, runId: 'R-001' });
    expect(done.run.status).toBe('completed');
    const events = await s.store.readEvents(s.task.id);
    expect((await collectExecution(s.ctx, { taskId: s.task.id, runId: 'R-001' })).run).toEqual(done.run);
    expect(await s.store.readEvents(s.task.id)).toEqual(events);
    expect((await s.store.get('task', { taskId: s.task.id }))?.status).toBe('open');
  });
  it('Reviewer requires pinned versions and records its output through the Gate command', async () => {
    const s = await ready(); const { refs } = await workerRound(s.ctx, s.task.id, s.prepared.location.head);
    await expect(submitRole(s.ctx, { taskId: s.task.id, stepId: 'step-001', runId: 'R-002', role: 'reviewer', input: { prompt: '{}' } })).rejects.toThrow(/Artifact versions/);
    const input = { taskId: s.task.id, stepId: 'step-001', runId: 'R-002', role: 'reviewer' as const, input: { prompt: spec('success', 0, reviewerOutput()).prompt, artifact_refs: refs } };
    const first = await submitRole(s.ctx, input);
    const packet = new TextDecoder().decode((await s.store.getBlob(blobRef({ taskId: s.task.id, stepId: 'step-001', runId: 'R-002' }, 'packet')))!);
    expect(JSON.parse(packet).artifactContents).toEqual(expect.arrayContaining([expect.objectContaining({ text: '# 노트\n' })]));
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    expect((await collectExecution(s.ctx, { taskId: s.task.id, runId: 'R-002' })).run.status).toBe('completed');
    expect((await s.store.list('gate_result', { taskId: s.task.id })).items[0]?.artifact_refs).toEqual(refs);
    expect((await s.store.get('step', { taskId: s.task.id, stepId: 'step-001' }))?.status).toBe('in_review');
  });
  it('refuses to review code when the workspace HEAD differs from the pinned version', async () => {
    const s = await ready(); const { refs } = await workerRound(s.ctx, s.task.id);
    await expect(submitRole(s.ctx, { taskId: s.task.id, stepId: 'step-001', runId: 'R-002', role: 'reviewer', input: { prompt: spec().prompt, artifact_refs: refs } })).rejects.toThrow(/pinned Artifact/);
    expect(await s.store.get('run', { taskId: s.task.id, id: 'R-002' })).toBeUndefined();
  });
  it('checks pinned code again immediately before launching the Reviewer', async () => {
    const s = await ready(); const { refs } = await workerRound(s.ctx, s.task.id, s.prepared.location.head);
    const prepare = s.runner.prepare.bind(s.runner);
    s.runner.prepare = async request => { await prepare(request); writeFileSync(join(s.prepared.location.workdir, 'unexpected.txt'), 'human edit'); };
    const started = await submitRole(s.ctx, { taskId: s.task.id, stepId: 'step-001', runId: 'R-002', role: 'reviewer', input: { prompt: spec('success', 0, reviewerOutput()).prompt, artifact_refs: refs } });
    await until(() => s.runner.inspect(executionKey(started.run)), terminal);
    const done = await collectExecution(s.ctx, { taskId: s.task.id, runId: 'R-002' });
    expect(done.run).toMatchObject({ status: 'invalidated', failure_kind: 'read_violation' });
    expect(done.run.process_ended_at).toBeUndefined();
    expect(readFileSync(join(s.prepared.location.workdir, 'unexpected.txt'), 'utf8')).toBe('human edit');
  });
  it('read postcondition catches ignored writes and preserves them', async () => {
    const s = await ready(), cwd = s.prepared.location.workdir;
    writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n');
    const input = { taskId: s.task.id, runId: 'R-001', role: 'planner' as const,
      input: { prompt: spec('success', 1200, JSON.stringify({ after_step: null, action: 'ask_human', rationale: 'Need input', question: { text: '?' }, packet_gaps: [] })).prompt } };
    const first = await submitRole(s.ctx, input);
    await until(async () => { try { return !!readFileSync(join(s.runnerDir, s.task.id, 'R-001', first.run.execution!.id, 'worker.json')); } catch { return false; } }, Boolean);
    writeFileSync(join(cwd, 'ignored.txt'), 'must remain');
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    expect((await collectExecution(s.ctx, { taskId: s.task.id, runId: 'R-001' })).run).toMatchObject({ status: 'invalidated', failure_kind: 'read_violation' });
    expect(readFileSync(join(cwd, 'ignored.txt'), 'utf8')).toBe('must remain');
  });
  it('cancel records intent before termination and releases the role only after collection', async () => {
    const s = await ready(); const first = await submitWorker(s.ctx, { ...s.input, input: spec('success', 10000) });
    await expect(submitRole(s.ctx, { taskId: s.task.id, runId: 'R-002', role: 'planner', input: { prompt: spec().prompt } })).rejects.toThrow(/uncollected/);
    await cancelExecution({ ...s.ctx, actor: 'human:tester' }, { taskId: s.task.id, runId: first.run.id });
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    const done = await collectExecution(s.ctx, { taskId: s.task.id, runId: first.run.id });
    expect(done.run).toMatchObject({ status: 'cancelled', failure_kind: 'cancelled' });
    expect((await s.store.readEvents(s.task.id)).map(e => e.type)).toEqual(expect.arrayContaining(['run.cancel_requested', 'run.cancelled']));
    expect((await s.store.list('artifact', { taskId: s.task.id })).items).toHaveLength(0);
  });
  it('timeout is a confirmed failure with a distinct process end timestamp', async () => {
    const s = await ready(); const first = await submitWorker(s.ctx, { ...s.input, input: { ...spec('success', 10000), timeout_seconds: 1 } });
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    expect((await collectExecution(s.ctx, { taskId: s.task.id, runId: first.run.id })).run).toMatchObject({ status: 'failed', failure_kind: 'timeout', process_ended_at: expect.any(String) });
  });
});
