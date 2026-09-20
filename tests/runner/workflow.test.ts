import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startWorkflow, advance, respondHitl, type WorkflowContext } from '../../src/commands/workflow.js';
import { openQuestion } from '../../src/commands/question.js';
import { operateExecution } from '../../src/commands/execution.js';
import { getWorkflow } from '../../src/queries/workflow.js';
import { submitRole } from '../../src/commands/roles.js';
import { approveStep, requestRevision } from '../../src/commands/review.js';
import { prepareWorkspace } from '../../src/commands/workspace.js';
import { setup, runGit } from '../workspace/helpers.js';
import type { ExecutionKey, ExecutionState, QuestionRequest, Runner, RunRequest } from '../../src/runner/types.js';
import type { Step, WorkflowInput, HitlTarget, ExecutionConfig } from '../../src/types/generated/index.js';
import type { Verifier, VerificationRequest, VerificationState } from '../../src/verification/types.js';
import { event } from '../store/records.js';
import { blobRef } from '../../src/store/blob-ref.js';

const definition = (deterministic = false) => ({ goal: 'Create report', scope: {}, inputs: ['task.brief'], outputs: [{ name: 'report', type: 'document' }], done_when: ['report exists'], verify: { semantic: ['accurate'], ...(deterministic ? { deterministic: [{ name: 'test', run: 'node -e "process.exit(0)"' }] } : {}) }, approval: 'required' });
const plan = (extra = {}) => JSON.stringify({ action: 'next_step', after_step: null, rationale: 'report first', next_step: { step: definition() }, packet_gaps: [], ...extra });
const worker = (text = 'version one') => JSON.stringify({ summary: text, work_notes: text, packet_gaps: [] });
const review = (verdict: 'pass' | 'fail' = 'pass') => JSON.stringify({ verdict, checks: [{ kind: 'semantic', name: 'accurate', result: verdict, evidence: 'reviewed' }], done_when: [{ condition: 'report exists', met: verdict === 'pass' }], comments: [], packet_gaps: [] });

class ScriptedRunner implements Runner {
  id = 'fake'; version = 'test'; capabilities = { supportsResume: false, supportsLiveMessage: false, supportsStream: false, supportsCancel: false };
  requests = new Map<string, RunRequest>(); states = new Map<string, ExecutionState>(); launched: RunRequest[] = [];
  questions: QuestionRequest[] = []; questionFailure = false; onQuestion?: () => Promise<void>;
  pauseRole?: string;
  outputs: Record<string, string[]> = { planner: [plan()], worker: [worker()], reviewer: [review()] };
  async prepare(request: RunRequest) {
    const saved = this.requests.get(request.key.executionId);
    if (saved) { expect(request).toEqual(saved); return; }
    this.requests.set(request.key.executionId, request); this.states.set(request.key.executionId, { state: 'prepared' });
  }
  async submit(request: RunRequest) {
    const state = await this.inspect(request.key); if (state.state !== 'prepared') return state;
    this.launched.push(request);
    if (this.pauseRole === request.role) { const pending = { state: 'running' as const }; this.states.set(request.key.executionId, pending); return pending; }
    const output = this.outputs[request.role]!.shift(); if (!output) throw new Error(`Missing ${request.role} test output`);
    const result: ExecutionState = { state: 'completed', workerOutput: output };
    this.states.set(request.key.executionId, result); return result;
  }
  async inspect(key: ExecutionKey): Promise<ExecutionState> { return this.states.get(key.executionId) ?? { state: 'unknown', reason: 'missing', action: 'inspect' }; }
  async openQuestion(request: QuestionRequest) {
    this.questions.push(request);
    if (this.questionFailure) throw new Error('terminal launch failed');
    await this.onQuestion?.();
  }
}
class ScriptedVerifier implements Verifier {
  requests: VerificationRequest[] = []; verdict: 'pass' | 'fail' = 'pass';
  async prepare(request: VerificationRequest) { if (!this.requests.some(r => r.id === request.id)) this.requests.push(request); }
  async submit(id: string) { return this.inspect(id); }
  async inspect(id: string): Promise<VerificationState> {
    const request = this.requests.find(r => r.id === id);
    if (!request) return { state: 'missing' };
    return { state: 'completed', result: { id, verdict: this.verdict, checks: request.commands.map(c => ({ name: c.name, kind: 'deterministic', result: this.verdict, evidence: 'exit=0' })) } };
  }
}
async function fixture(config: WorkflowInput = {}) {
  const s = await setup('local'); const prepared = await prepareWorkspace(s.ctx, { taskId: s.task.id });
  const runner = new ScriptedRunner(), verifier = new ScriptedVerifier();
  const ctx: WorkflowContext = { ...s.ctx, runner, verifier, settings: { read: async () => ({ global: { roles: { question: { backend: 'fake' } } } }) } };
  const start = () => startWorkflow(ctx, { taskId: s.task.id, config });
  const view = () => getWorkflow(ctx, s.task.id);
  const answer = (target: HitlTarget, response: 'approve' | 'revise' = 'approve', text?: string, destination?: 'worker' | 'reviewer') => respondHitl(ctx, { taskId: s.task.id, target, response, ...(text ? { text } : {}), ...(destination ? { destination } : {}) });
  return { ...s, ctx, runner, verifier, prepared, start, view, answer };
}

describe('role HITL workflow', () => {
  it('stops separately at Planner, Worker and Reviewer, then requires final version approval', async () => {
    const s = await fixture();
    let view = await s.start(); expect(view.target?.role).toBe('planner'); expect(s.runner.launched.map(r => r.role)).toEqual(['planner']);
    const planner = view.target!;
    const events = await s.store.readEvents(s.task.id);
    await advance(s.ctx, { taskId: s.task.id }); expect(await s.store.readEvents(s.task.id)).toEqual(events);
    view = await s.answer(planner); expect(view.target?.role).toBe('worker'); expect(view.target?.artifact_refs).toEqual([`artifact://${s.task.id}/step-001/report@v1`]);
    expect(s.runner.launched.map(r => r.role)).toEqual(['planner', 'worker']);
    expect(view.step?.approval).toBe('required');
    const workerTarget = view.target!;
    await s.answer(planner); expect(s.runner.launched).toHaveLength(2); // exact duplicate is a receipt only
    await expect(s.answer(planner, 'revise', 'old')).rejects.toThrow(/different response/);
    await expect(s.answer({ ...workerTarget, artifact_refs: [workerTarget.artifact_refs[0]!.replace('@v1', '@v99')] })).rejects.toThrow(/stale/);
    view = await s.answer(workerTarget); expect(view.target?.role).toBe('reviewer'); expect(view.step?.status).toBe('checking');
    expect((await s.store.readEvents(s.task.id)).filter(e => e.type === 'artifact.approved')).toHaveLength(0);
    view = await s.answer(view.target!); expect(view.target?.role).toBe('artifact'); expect(view.step?.status).toBe('in_review');
    s.runner.outputs.planner!.push(JSON.stringify({ action: 'done', after_step: 'step-001', rationale: 'all complete', completion: [{ ac_id: 'AC1', evidence: 'report approved' }], packet_gaps: [] }));
    view = await s.answer(view.target!); expect(view.target?.role).toBe('planner');
    view = await s.answer(view.target!); expect(view.workflow?.phase).toBe('ready_to_complete');
    expect((await s.store.get('task', { taskId: s.task.id }))?.status).toBe('open');
  });

  it('Planner revision preserves the old proposal, records supersedes, and sends the request to a new session', async () => {
    const s = await fixture(); const original = (await s.start()).target!;
    s.runner.outputs.planner!.push(plan({ rationale: 'revised proposal' }));
    const revised = await s.answer(original, 'revise', 'Narrow the report');
    expect(revised.target).toMatchObject({ role: 'planner', decision_id: 'D-002', step_id: 'step-002' });
    expect(revised.decision?.supersedes).toBe('D-001');
    expect((await s.store.get('step', { taskId: s.task.id, stepId: 'step-001' }))?.status).toBe('cancelled');
    expect((await s.store.get('decision', { taskId: s.task.id, id: 'D-001' }))?.rationale).toBe('report first');
    const request = s.runner.launched.at(-1)!; expect(request.context).toContain('Narrow the report'); expect(request.context).toContain('report first');
    expect(request.key.executionId).not.toBe(s.runner.launched[0]!.key.executionId);
  });

  it('Worker revision creates v2 in the same worktree and returns to Worker HITL before verification', async () => {
    const s = await fixture(); const first = await s.answer((await s.start()).target!);
    s.runner.outputs.worker!.push(worker('version two'));
    const second = await s.answer(first.target!, 'revise', 'Include the missing detail');
    expect(second.target?.role).toBe('worker'); expect(second.target?.artifact_refs[0]).toMatch(/@v2$/);
    expect(s.runner.launched.at(-1)?.workdir).toBe(s.runner.launched[1]?.workdir);
    expect(s.runner.launched.at(-1)?.context).toContain('Include the missing detail');
    expect(s.runner.launched.at(-1)?.context).toContain('version one');
    expect(s.runner.launched.some(r => r.role === 'reviewer')).toBe(false);
    const reviewer = await s.answer(second.target!); expect(reviewer.gate?.artifact_refs[0]).toMatch(/@v2$/);
    expect((await s.store.list('artifact', { taskId: s.task.id })).items).toHaveLength(2);
  });

  it('accepting Reviewer fail reworks instead of passing; reconsideration preserves Gate and exact versions', async () => {
    const s = await fixture(); s.runner.outputs.reviewer = [review('fail'), review('fail')];
    let view = await s.answer((await s.answer((await s.start()).target!)).target!);
    const failedTarget = view.target!;
    await expect(s.answer(failedTarget, 'revise', 'Reconsider')).rejects.toThrow(/Select worker/);
    view = await s.answer(failedTarget, 'revise', 'Reconsider the evidence', 'reviewer');
    expect(view.target).toMatchObject({ role: 'reviewer', gate_id: 'G-002', artifact_refs: failedTarget.artifact_refs });
    expect((await s.store.list('gate_result', { taskId: s.task.id })).items).toHaveLength(2);
    expect(s.runner.launched.at(-1)?.context).toContain('Reconsider the evidence');
    s.runner.outputs.worker!.push(worker('fixed report'));
    view = await s.answer(view.target!); expect(view.target?.role).toBe('worker'); expect(view.target?.artifact_refs[0]).toMatch(/@v2$/);
    expect((await s.store.get('gate_result', { taskId: s.task.id, stepId: 'step-001', id: 'G-001' }))?.verdict).toBe('fail');
    expect((await s.store.readEvents(s.task.id)).some(e => e.type === 'artifact.approved')).toBe(false);
  });

  it('Reviewer artifact-change revision goes to Worker, and the new version is checked again', async () => {
    const s = await fixture(); s.runner.outputs.planner = [plan({ next_step: { step: definition(true) } })];
    let view = await s.answer((await s.answer((await s.start()).target!)).target!);
    expect(s.verifier.requests).toHaveLength(1);
    s.runner.outputs.worker!.push(worker('new')); s.runner.outputs.reviewer!.push(review());
    view = await s.answer(view.target!, 'revise', 'Change the report', 'worker');
    expect(view.target?.role).toBe('worker');
    view = await s.answer(view.target!); expect(s.verifier.requests).toHaveLength(2);
    expect(view.gate?.artifact_refs[0]).toMatch(/@v2$/);
    expect(view.gate?.checks.map(c => c.kind)).toEqual(['deterministic', 'semantic']);
  });

  it('can disable role HITLs without bypassing mandatory final Artifact approval', async () => {
    const s = await fixture({ hitl: { planner: false, worker: false, reviewer: false } });
    const view = await s.start(); expect(view.target?.role).toBe('artifact'); expect(view.step?.status).toBe('in_review');
    expect(s.runner.launched.map(r => r.role)).toEqual(['planner', 'worker', 'reviewer']);
  });

  it('does not carry deterministic evidence from the previous Step into a semantic-only Step', async () => {
    const s = await fixture(); s.runner.outputs.planner = [plan({ next_step: { step: definition(true) } }), plan()];
    s.runner.outputs.worker!.push(worker('second step')); s.runner.outputs.reviewer!.push(review());
    let view = await s.answer((await s.answer((await s.start()).target!)).target!);
    expect(view.gate?.checks.map(c => c.kind)).toEqual(['deterministic', 'semantic']);
    view = await s.answer(view.target!); view = await s.answer(view.target!);
    expect(view.workflow?.verification).toBeUndefined();
    view = await s.answer(view.target!); view = await s.answer(view.target!);
    expect(view.target?.step_id).toBe('step-002');
    expect(view.gate?.checks.map(c => c.kind)).toEqual(['semantic']);
    expect(s.verifier.requests).toHaveLength(1);
  });

  it('collects a completed verification failure after files change, preserving changes before another Worker', async () => {
    const s = await fixture(); s.runner.outputs.planner = [plan({ next_step: { step: definition(true) } })];
    const inspect = s.verifier.inspect.bind(s.verifier); let running = true;
    s.verifier.inspect = async id => s.verifier.requests.some(r => r.id === id) && running ? { state: 'running' } : inspect(id);
    const workerView = await s.answer((await s.start()).target!);
    await s.answer(workerView.target!); expect((await s.view()).workflow?.phase).toBe('verification');
    writeFileSync(join(s.prepared.location.workdir, 'tracked.txt'), 'check changed this\n');
    running = false; s.verifier.verdict = 'fail';
    await expect(advance(s.ctx, { taskId: s.task.id })).rejects.toThrow(/reconcile/);
    expect((await s.store.list('gate_result', { taskId: s.task.id })).items).toMatchObject([{ verdict: 'fail' }]);
    expect((await s.view()).workflow?.phase).toBe('worker');
    expect(s.verifier.requests).toHaveLength(1); expect(s.runner.launched.filter(r => r.role === 'worker')).toHaveLength(1);
    expect(runGit(s.prepared.location.workdir, 'diff')).toContain('check changed this');
  });

  it('deterministic-only optional flow skips Reviewer, but failure returns to enabled Worker HITL', async () => {
    const s = await fixture(); const def = { ...definition(true), verify: { deterministic: [{ name: 'test', run: 'node -e "process.exit(0)"' }] }, approval: 'optional' };
    s.runner.outputs.planner = [plan({ next_step: { step: def } })];
    let view = await s.answer((await s.start()).target!); s.verifier.verdict = 'fail'; s.runner.outputs.worker!.push(worker('retry'));
    view = await s.answer(view.target!); expect(view.target?.role).toBe('worker'); expect(view.target?.artifact_refs[0]).toMatch(/@v2$/);
    s.verifier.verdict = 'pass'; s.runner.outputs.planner!.push(plan());
    view = await s.answer(view.target!); expect(view.target?.role).toBe('planner'); expect(s.runner.launched.some(r => r.role === 'reviewer')).toBe(false);
    expect((await s.store.list('gate_result', { taskId: s.task.id })).items.map(g => g.verdict)).toEqual(['fail', 'pass']);
  });

  it('independent question stays outside Runs and allows approval while its window remains open', async () => {
    const s = await fixture(); const target = (await s.answer((await s.start()).target!)).target!;
    const before = (await s.store.list('run', { taskId: s.task.id })).items.length;
    const result = await openQuestion(s.ctx, { taskId: s.task.id, target, text: 'Why this result?' });
    expect(result.handedOff).toBe(true); expect(s.runner.questions).toHaveLength(1);
    expect((await s.store.list('run', { taskId: s.task.id })).items).toHaveLength(before);
    const context = s.runner.questions[0]!.context; expect(context).toContain('version one'); expect(context).toContain('@v1');
    const next = await s.answer(target); expect(next.target?.role).toBe('reviewer');
    expect(s.runner.questions[0]!.context).toBe(context); // no live synchronization
  });

  it('selects question AI independently, applies only confirmed Step settings, and freezes each handoff', async () => {
    const s = await fixture(), questionRunner = new ScriptedRunner(); questionRunner.id = 'codex';
    let global: ExecutionConfig = { defaults: { backend: 'fake' }, roles: { question: { backend: 'codex', model: 'gpt-5', reasoning: 'high' } } };
    s.ctx.settings = { read: async () => ({ global }) };
    s.ctx.runners = { get: backend => backend === 'codex' ? questionRunner : s.runner };
    s.runner.outputs.planner = [plan({ next_step: { step: { ...definition(), execution: { question: { model: 'gpt-5.5', reasoning: 'low' } } } } })];
    const planner = (await s.start()).target!;
    const before = (await s.store.list('run', { taskId: s.task.id })).items.length;
    const first = await openQuestion(s.ctx, { taskId: s.task.id, target: planner, text: 'Explain the proposal' });
    expect(first.settings.values).toEqual({ backend: 'codex', model: 'gpt-5', reasoning: 'high' });
    expect(questionRunner.questions[0]).toMatchObject({ model: 'gpt-5', reasoning: 'high' });
    expect(s.runner.questions).toHaveLength(0);
    expect((await s.store.list('run', { taskId: s.task.id })).items).toHaveLength(before);
    const workerTarget = (await s.answer(planner)).target!;
    const second = await openQuestion(s.ctx, { taskId: s.task.id, target: workerTarget, text: 'Explain the result' });
    expect(second.settings.values).toEqual({ backend: 'codex', model: 'gpt-5.5', reasoning: 'low' });
    expect(second.settings.sources).toMatchObject({ model: 'step', reasoning: 'step' });
    const snapshot = questionRunner.questions[1]!.context;
    global = { roles: { question: { backend: 'codex', model: 'gpt-5', reasoning: 'medium' } } };
    await operateExecution(s.ctx, { action: 'question', taskId: s.task.id, target: workerTarget, text: 'Use defaults', model: null, reasoning: null });
    expect(questionRunner.questions[2]).not.toHaveProperty('model'); expect(questionRunner.questions[2]).not.toHaveProperty('reasoning');
    expect(questionRunner.questions[1]!.context).toBe(snapshot);
    const events = (await s.store.readEvents(s.task.id)).filter(e => e.type === 'question.requested');
    expect(events[0]?.data).toMatchObject({ resolved_settings: { values: first.settings.values } });
    expect(events[2]?.data).toMatchObject({ resolved_settings: { values: { backend: 'codex', model: null, reasoning: null } } });
  });

  it('question handoff failure leaves the pending result and Task unchanged; late handoff can race with approval', async () => {
    const s = await fixture(); const target = (await s.start()).target!;
    const before = (await s.view()).workflow; s.runner.questionFailure = true;
    const result = await openQuestion(s.ctx, { taskId: s.task.id, target, text: 'Explain' });
    expect(result).toMatchObject({ handedOff: false, error: 'terminal launch failed' }); expect((await s.view()).workflow).toEqual(before);
    s.runner.questionFailure = false; s.runner.onQuestion = async () => { await s.answer(target); };
    expect((await openQuestion(s.ctx, { taskId: s.task.id, target, text: 'Explain again' })).handedOff).toBe(true);
    expect((await s.view()).target?.role).toBe('worker');
    await expect(openQuestion(s.ctx, { taskId: s.task.id, target, text: 'old' })).rejects.toThrow(/stale/);
    const events = (await s.store.readEvents(s.task.id)).map(e => e.type);
    expect(events).toContain('question.failed'); expect(events).toContain('question.handed_off');
  });

  it('reads fixed Git objects, including exact whitespace, instead of the changed worktree', async () => {
    const s = await fixture(); const sha = s.prepared.location.head, target = (await s.start()).target!;
    writeFileSync(join(s.prepared.location.workdir, 'tracked.txt'), 'new contents\n');
    const files = await s.workspace.snapshot!('sample', sha);
    expect(Buffer.from(files.find(f => f.path === 'tracked.txt')!.base64, 'base64').toString()).toBe('initial\n');
    await openQuestion(s.ctx, { taskId: s.task.id, target, text: 'Explain the code used by Planner' });
    const snapshot = JSON.parse(s.runner.questions[0]!.context).code[0];
    expect(snapshot.sha).toBe(sha); expect(snapshot.files).toEqual(files);
    expect(runGit(s.prepared.location.workdir, 'diff')).toContain('new contents');
  });

  it('blocks record-only transitions and role starts from bypassing a pending HITL', async () => {
    const s = await fixture(); const view = await s.answer((await s.start()).target!);
    await expect(submitRole(s.ctx, { taskId: s.task.id, stepId: 'step-001', role: 'reviewer', runId: 'R-003', input: { prompt: 'ignore hitl', artifact_refs: view.target!.artifact_refs } })).rejects.toThrow(/HITL cannot be bypassed/);
    await expect(approveStep(s.ctx, { taskId: s.task.id, stepId: 'step-001', gateId: 'G-001', text: 'skip' })).rejects.toThrow(/current HITL/);
    await expect(requestRevision(s.ctx, { taskId: s.task.id, stepId: 'step-001', artifactRef: view.target!.artifact_refs[0]!, text: 'skip' })).rejects.toThrow(/current HITL/);
  });

  it('keeps unknown executions reserved and recovers the same result without replacement', async () => {
    const s = await fixture(); s.runner.pauseRole = 'planner';
    const started = await s.start(); const action = started.workflow!.action!;
    s.runner.states.set(action.id, { state: 'unknown', reason: 'supervisor unavailable', action: 'inspect original execution' });
    await advance(s.ctx, { taskId: s.task.id }); await advance(s.ctx, { taskId: s.task.id });
    expect(s.runner.launched).toHaveLength(1); expect((await s.view()).workflow?.action?.id).toBe(action.id);
    s.runner.states.set(action.id, { state: 'completed', workerOutput: plan() });
    expect((await advance(s.ctx, { taskId: s.task.id })).target?.role).toBe('planner');
    expect(s.runner.launched).toHaveLength(1);
  });

  it('rejects incompatible concurrent answers and old results after the next Step has started', async () => {
    const s = await fixture(); const original = (await s.start()).target!;
    const outcomes = await Promise.allSettled([s.answer(original), s.answer(original, 'revise', 'conflicting choice')]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect((await s.store.readEvents(s.task.id)).filter(e => e.type === 'hitl.responded' && (e.data as { target?: HitlTarget })?.target?.id === original.id)).toHaveLength(1);
    expect(s.runner.launched.filter(r => r.role === 'worker')).toHaveLength(1);
    let view = await s.answer((await s.view()).target!); view = await s.answer(view.target!);
    s.runner.outputs.planner!.push(plan()); s.runner.outputs.worker!.push(worker('second step'));
    view = await s.answer(view.target!); expect(view.target?.step_id).toBe('step-002');
    view = await s.answer(view.target!); expect(view.target?.role).toBe('worker'); expect(view.target?.step_id).toBe('step-002');
    await expect(s.answer(original, 'revise', 'change old step')).rejects.toThrow(/different response/);
  });
});
