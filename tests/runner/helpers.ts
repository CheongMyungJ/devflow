import { join } from 'node:path';
import { prepareWorkspace } from '../../src/commands/workspace.js';
import { FakeRunner } from '../../src/runner/fake/runner.js';
import type { ExecutionState } from '../../src/runner/types.js';
import { event, step } from '../store/records.js';
import { setup, runGit } from '../workspace/helpers.js';
import { artifactsOf } from '../commands/round-helpers.js';

export const spec = (mode = 'success', delayMs = 0, output = JSON.stringify({ summary: 'fake completed', packet_gaps: [], work_notes: '# notes' })) => ({
  prompt: JSON.stringify({ mode, delayMs, output }), artifacts: artifactsOf(),
});
export async function ready(sharedUrl?: string) {
  const s = await setup('local');
  if (sharedUrl) {
    runGit(s.clone, 'remote', 'set-url', 'origin', sharedUrl);
    runGit(s.clone, 'config', `url.${s.remote.replaceAll('\\', '/')}.insteadOf`, sharedUrl);
    s.catalog.remoteUrl = async () => sharedUrl;
    s.catalog.locate = async () => ({ url: sharedUrl, clone: s.clone, worktreeRoot: s.worktreeRoot, remote: 'origin' });
  }
  const prepared = await prepareWorkspace(s.ctx, { taskId: s.task.id });
  await s.store.commit(s.task.id, { writes: [{ kind: 'step', value: step(s.task.id, 'step-001', 'defined') }], events: [event('step.defined', { step_id: 'step-001' })] });
  const runnerDir = join(s.root, 'runner');
  const runner = new FakeRunner(runnerDir);
  return { ...s, prepared, runnerDir, runner, ctx: { ...s.ctx, runner },
    input: { taskId: s.task.id, stepId: 'step-001', runId: 'R-001', input: spec() } };
}
export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
export const terminal = (s: ExecutionState) => s.state === 'completed' || s.state === 'failed';
