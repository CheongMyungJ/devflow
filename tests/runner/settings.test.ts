import { describe, expect, it } from 'vitest';
import { resolveExecutionSettings } from '../../src/settings/resolve.js';
import { submitWorker, collectWorker } from '../../src/commands/worker.js';
import { ready, spec, terminal, until } from './helpers.js';
import { executionKey } from '../../src/runner/records.js';
import type { ExecutionConfig } from '../../src/types/generated/index.js';

describe('role execution settings', () => {
  it.each(['intake', 'planner', 'worker', 'reviewer'] as const)('%s resolves every layer and explains its source', role => {
    const resolved = resolveExecutionSettings({ global: { defaults: { backend: 'codex', model: 'gpt-5', reasoning: 'low' }, roles: { [role]: { reasoning: 'medium' } }, task_types: { research: { [role]: { timeout_seconds: 10 } } } },
      project: { roles: { [role]: { model: 'gpt-5.5' } }, task_types: { research: { [role]: { reasoning: 'high' } } } } },
    { role, taskType: 'research', step: { timeout_seconds: 20 }, explicit: { reasoning: 'xhigh' } });
    expect(resolved.values).toMatchObject({ backend: 'codex', model: 'gpt-5.5', reasoning: 'xhigh', timeout_seconds: 20 });
    expect(resolved.sources).toMatchObject({ backend: 'global.defaults', model: 'project.role', reasoning: 'explicit', timeout_seconds: 'step' });
  });
  it('backend changes clear incompatible inherited model and reasoning; null resets defaults', () => {
    expect(resolveExecutionSettings({ global: { defaults: { backend: 'codex', model: 'gpt-5', reasoning: 'high' } }, project: { roles: { worker: { backend: 'claude-code' } } } }, { role: 'worker' }).values).not.toHaveProperty('model');
    expect(resolveExecutionSettings({ global: { roles: { worker: { model: 'old' } } } }, { role: 'worker', explicit: { model: null } }).values.model).toBeNull();
    expect(() => resolveExecutionSettings({ global: { roles: { unknown: {} } } as ExecutionConfig }, { role: 'worker' })).toThrow(/Invalid/);
    expect(() => resolveExecutionSettings({}, { role: 'worker', explicit: { timeout_seconds: 0 } })).toThrow(/Invalid/);
  });
  it('question follows every settings layer and excludes managed lifecycle defaults', () => {
    const configs: { global: ExecutionConfig; project: ExecutionConfig } = {
      global: { defaults: { backend: 'codex', model: 'gpt-5.5', reasoning: 'low', timeout_seconds: 30, isolation: 'strict', output_retries: 2 },
        roles: { question: { reasoning: 'medium' } }, task_types: { research: { question: { model: 'gpt-5' } } } },
      project: { roles: { question: { model: 'gpt-5.5' } }, task_types: { research: { question: { reasoning: 'high' } } } },
    };
    const selection = { role: 'question' as const, taskType: 'research' };
    expect(resolveExecutionSettings(configs, selection)).toEqual({ values: { backend: 'codex', model: 'gpt-5.5', reasoning: 'high' },
      sources: { backend: 'global.defaults', model: 'project.role', reasoning: 'project.task_type' } });
    const step = resolveExecutionSettings(configs, { ...selection, step: { model: 'gpt-5' }, explicit: { reasoning: 'xhigh' } });
    expect(step.values).toEqual({ backend: 'codex', model: 'gpt-5', reasoning: 'xhigh' });
    expect(step.sources).toMatchObject({ model: 'step', reasoning: 'explicit' });
    expect(resolveExecutionSettings(configs, { ...selection, explicit: { backend: 'claude-code' } }).values).toEqual({ backend: 'claude-code' });
    expect(resolveExecutionSettings(configs, { ...selection, explicit: { model: null, reasoning: null } }).values).toEqual({ backend: 'codex', model: null, reasoning: null });
    expect(resolveExecutionSettings({}, selection).values).toEqual({ backend: 'codex' });
    expect(() => resolveExecutionSettings({ global: { roles: { question: { timeout_seconds: 1 } } } } as never, selection)).toThrow(/Invalid/);
    expect(() => resolveExecutionSettings({}, { ...selection, explicit: { isolation: 'project' } })).toThrow(/Invalid/);
  });
  it('configuration edits cannot change a submitted execution or its collection', async () => {
    const s = await ready(); let global: ExecutionConfig = { roles: { worker: { timeout_seconds: 30 } } };
    const ctx = { ...s.ctx, settings: { read: async () => ({ global }) } };
    const input = { ...s.input, input: spec('success', 500) };
    const first = await submitWorker(ctx, input);
    global = { roles: { worker: { backend: 'codex', model: 'different', timeout_seconds: 1 } } };
    const again = await submitWorker(ctx, input);
    expect(again.run.execution).toEqual(first.run.execution);
    expect(again.run.resolved_settings?.values).toMatchObject({ backend: 'fake', timeout_seconds: 30 });
    await expect(submitWorker(ctx, { ...input, input: spec('success', 501) })).rejects.toThrow(/different input/);
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    expect((await collectWorker(ctx, { taskId: s.task.id, runId: first.run.id })).run.status).toBe('completed');
  });
  it('explicit null removes an inherited model before executing the selected backend', async () => {
    const s = await ready();
    const ctx = { ...s.ctx, settings: { read: async () => ({ global: { roles: { worker: { model: 'fake-does-not-support-models' } } } }) } };
    const started = await submitWorker(ctx, { ...s.input, input: { ...spec(), model: null } });
    expect(started.run.model).toBeUndefined();
    expect(started.run.resolved_settings?.values.model).toBeNull();
    await until(() => s.runner.inspect(executionKey(started.run)), terminal);
    expect((await collectWorker(ctx, { taskId: s.task.id, runId: started.run.id })).run.status).toBe('completed');
  });
});
