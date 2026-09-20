import { randomUUID } from 'node:crypto';
import type { Change, CommitContext, NewEvent } from '../store/types.js';
import type { Feedback, GateResult, HitlTarget, RoleExecutionInput, Step, Task, Workflow, WorkflowInput } from '../types/generated/index.js';
import type { Verifier, VerificationState } from '../verification/types.js';
import { ExecutionError } from '../runner/types.js';
import { getWorkflow } from '../queries/workflow.js';
import { getWorkspace } from '../queries/workspace.js';
import { getExecution } from '../queries/execution.js';
import { submitWorker, type WorkerCommandContext } from './worker.js';
import { collectExecution, submitRole } from './roles.js';
import { checkArtifactRef, checkKeys, commitAfterReading, humanId, openTask, rejectIf, sameJson, schemaIssues, tail } from './common.js';
import { nextStepStatus, statusChangedEvents } from './transitions.js';
import { recordedAt } from './time.js';

export interface WorkflowContext extends WorkerCommandContext { verifier?: Verifier }
class Moved extends Error {}
type Extras = Pick<Change, 'writes' | 'blobs'> & { events?: NewEvent[] };

/** Compare the entire cursor inside the Store CAS retry. A racing caller never advances a newer result. */
async function move(ctx: WorkflowContext, task: Task, prepare: (current: Task, flow: Workflow) => Promise<(c: CommitContext) => { flow: Workflow; extras?: Extras }>, type: NewEvent['type'] = 'workflow.advanced') {
  await commitAfterReading(ctx, task.id, async () => {
    const current = await openTask(ctx, task.id);
    if (!current.workflow || !sameJson(current.workflow, task.workflow)) throw new Moved();
    const build = await prepare(current, structuredClone(current.workflow));
    return c => {
      const { flow, extras = {} } = build(c);
      return { writes: [{ kind: 'task', value: { ...current, workflow: flow } }, ...(extras.writes ?? [])],
        ...(extras.blobs ? { blobs: extras.blobs } : {}),
        events: [{ type, actor: 'system', data: { phase: flow.phase, ...(flow.pending ? { target: flow.pending } : {}), ...(flow.action ? { action: flow.action } : {}) }, ...tail(ctx, recordedAt(ctx.clock)) }, ...(extras.events ?? [])] };
    };
  });
}

export async function startWorkflow(ctx: WorkflowContext, input: { taskId: string; config?: WorkflowInput }) {
  checkKeys(input, ['taskId', 'config']); humanId(ctx);
  const config = input.config ?? {};
  rejectIf(schemaIssues('workflow-input', config, 'config'));
  for (const role of ['planner', 'worker', 'reviewer'] as const) {
    if (config[role]?.artifact_refs || config[role]?.deterministic || config[role]?.resolved_settings) throw new ExecutionError('Workflow owns Artifact references, deterministic evidence and resolved settings');
  }
  const saved = await openTask(ctx, input.taskId);
  if (saved.workflow) {
    if (!sameJson(saved.workflow.config, config)) throw new ExecutionError('Workflow already started with different configuration');
    return advance(ctx, { taskId: input.taskId });
  }
  await commitAfterReading(ctx, input.taskId, async () => {
    const task = await openTask(ctx, input.taskId);
    if (task.workflow) throw new Moved();
    const runs = (await ctx.store.list('run', { taskId: input.taskId })).items;
    if (runs.some(r => r.status === 'submitted')) throw new ExecutionError('Collect the current Run before starting a workflow');
    const steps = (await ctx.store.list('step', { taskId: input.taskId })).items.filter(s => !['closed', 'cancelled'].includes(s.status));
    if (steps.length > 1 || steps.some(s => s.status !== 'defined')) throw new ExecutionError('Start with no open Step or one already defined Step');
    const workflow: Workflow = { config, phase: steps.length ? 'worker' : 'planner', artifact_refs: [], ...(steps[0] ? { step_id: steps[0].id } : {}) };
    return () => ({ writes: [{ kind: 'task', value: { ...task, workflow } }], events: [{ type: 'workflow.started', actor: ctx.actor, data: { config }, ...tail(ctx, recordedAt(ctx.clock)) }] });
  });
  return advance(ctx, { taskId: input.taskId });
}

const prompts = {
  planner: 'Use the recorded Task, previous decisions, artifacts, gates and human revision request to propose the next action. Produce a full Step definition for next_step. Do not modify project files.',
  worker: 'Implement the defined Step in this Task worktree. Address the recorded revision request and prior findings. Preserve earlier commits. Commit code changes and provide complete work_notes for document/data outputs.',
  reviewer: 'Review only the pinned Artifact versions against every declared semantic check and done_when. Read the actual deterministic evidence. Report fail for unmet conditions. Do not modify artifacts.',
};

/** Bounded deterministic orchestration: submit/inspect/collect, then stop at asynchronous work or human input. */
export async function advance(ctx: WorkflowContext, input: { taskId: string }) {
  checkKeys(input, ['taskId']);
  // Always assemble Worker revision Context, even when a caller did not supply settings.
  ctx = { ...ctx, settings: ctx.settings ?? { read: async () => ({}) } };
  try {
    for (let budget = 0; budget < 16; budget++) {
      const task = await openTask(ctx, input.taskId), flow = task.workflow;
      if (!flow) throw new ExecutionError('Start a workflow first');
      if (flow.phase === 'hitl' && flow.pending && flow.pending.role !== 'artifact' && flow.config.hitl?.[flow.pending.role] === false) {
        await respond(ctx, task, flow.pending, 'approve', 'Configured automatic acceptance', undefined, false);
        continue;
      }
      if (['hitl', 'artifact_approval', 'paused', 'ready_to_complete'].includes(flow.phase)) return getWorkflow(ctx, task.id);
      if (!flow.action) {
        await move(ctx, task, async (_task, next) => c => {
          const kind = next.phase as 'planner' | 'worker' | 'reviewer' | 'verification';
          next.action = { id: randomUUID(), kind, ...(kind !== 'verification' ? { run_id: c.nextId('run') } : {}) };
          return { flow: next };
        }, 'workflow.action_reserved');
        continue;
      }
      if (flow.action.kind === 'verification') {
        const result = await verify(ctx, task);
        if (result !== true) return { ...await getWorkflow(ctx, task.id), verificationExecution: result };
        continue;
      }
      const action = flow.action, role = action.kind as 'planner' | 'worker' | 'reviewer', runId = action.run_id!;
      const saved = await ctx.store.get('run', { taskId: task.id, id: runId });
      if (!saved || saved.status === 'submitted') {
        const roleInput: RoleExecutionInput = flow.config[role] ?? { prompt: prompts[role] };
        const runCtx = { ...ctx, workflowActionId: action.id };
        if (!saved) {
          if (role === 'worker') {
            const step = await ctx.store.get('step', { taskId: task.id, stepId: flow.step_id! });
            if (!step) throw new ExecutionError('Workflow Step is missing');
            await submitWorker(runCtx, { taskId: task.id, stepId: step.id, runId,
              input: { ...roleInput, artifacts: step.outputs.map(o => ({ name: o.name, source: o.type === 'code_change' ? 'workspace:code' : 'blob:work-notes' })) } });
          } else await submitRole(runCtx, { taskId: task.id, runId, role,
            ...(role === 'reviewer' ? { stepId: flow.step_id! } : {}),
            input: { ...roleInput, ...(role === 'reviewer' ? { artifact_refs: flow.artifact_refs, ...(flow.verification ? { deterministic: JSON.stringify(flow.verification) } : {}) } : {}) } });
        }
        const status = await getExecution(ctx, { taskId: task.id, runId });
        if (status.execution.state === 'prepared') {
          // Resubmit only a known prepared Run, using the original input and stable action identity.
          if (role === 'worker') {
            const step = (await ctx.store.get('step', { taskId: task.id, stepId: flow.step_id! }))!;
            await submitWorker(runCtx, { taskId: task.id, stepId: step.id, runId, input: { ...roleInput, artifacts: step.outputs.map(o => ({ name: o.name, source: o.type === 'code_change' ? 'workspace:code' : 'blob:work-notes' })) } });
          } else await submitRole(runCtx, { taskId: task.id, runId, role, ...(role === 'reviewer' ? { stepId: flow.step_id! } : {}), input: { ...roleInput, ...(role === 'reviewer' ? { artifact_refs: flow.artifact_refs, ...(flow.verification ? { deterministic: JSON.stringify(flow.verification) } : {}) } : {}) } });
          return getWorkflow(ctx, task.id);
        }
        if (!['completed', 'failed'].includes(status.execution.state)) return { ...await getWorkflow(ctx, task.id), execution: status.execution };
        await collectExecution(ctx, { taskId: task.id, runId });
      }
      const run = (await ctx.store.get('run', { taskId: task.id, id: runId }))!;
      if (run.status !== 'completed') {
        await move(ctx, task, async (_task, next) => () => ({ flow: { ...next, phase: 'paused', reason: `Run ${run.id}: ${run.status}; inspect its recorded failure before any new execution` } }));
        return getWorkflow(ctx, task.id);
      }
      await move(ctx, task, async (_task, next) => {
        const target: HitlTarget = { id: randomUUID(), role, run_id: run.id, artifact_refs: [...next.artifact_refs] };
        if (role === 'planner') {
          const decision = (await ctx.store.list('decision', { taskId: task.id })).items.find(d => d.planner_run_id === run.id);
          if (!decision) throw new ExecutionError('Planner result is missing');
          target.decision_id = decision.id; next.decision_id = decision.id;
          const step = (await ctx.store.list('step', { taskId: task.id })).items.find(s => s.created_from === decision.id);
          if (step) { next.step_id = step.id; target.step_id = step.id; }
          else delete next.step_id;
        } else {
          target.step_id = next.step_id!;
          if (role === 'worker') {
            next.artifact_refs = (await ctx.store.list('artifact', { taskId: task.id, stepId: next.step_id! })).items.filter(a => a.run_id === run.id).map(a => a.ref);
            target.artifact_refs = [...next.artifact_refs]; delete next.verification; delete next.gate_id;
          } else {
            const gate = (await ctx.store.list('gate_result', { taskId: task.id, stepId: next.step_id! })).items.find(g => g.reviewer_run_id === run.id);
            if (!gate) throw new ExecutionError('Reviewer result is missing');
            target.gate_id = gate.id; next.gate_id = gate.id;
          }
        }
        delete next.action; next.pending = target; next.phase = 'hitl';
        return () => ({ flow: next });
      }, 'hitl.waiting');
      const waiting = (await ctx.store.get('task', { taskId: task.id }))!;
      if (waiting.workflow!.config.hitl?.[role] === false) {
        await respond(ctx, waiting, waiting.workflow!.pending!, 'approve', 'Configured automatic acceptance', undefined, false);
        continue;
      }
      return getWorkflow(ctx, task.id);
    }
    return getWorkflow(ctx, input.taskId);
  } catch (error) {
    if (error instanceof Moved) return getWorkflow(ctx, input.taskId);
    throw error;
  }
}

async function verify(ctx: WorkflowContext, task: Task): Promise<true | VerificationState> {
  const flow = task.workflow!, step = (await ctx.store.get('step', { taskId: task.id, stepId: flow.step_id! }))!;
  const commands = step.verify.deterministic ?? [];
  if (!commands.length) {
    await move(ctx, task, async (_task, next) => () => { delete next.action; next.phase = 'reviewer'; return { flow: next }; });
    return true;
  }
  if (!ctx.verifier) throw new ExecutionError('Deterministic Verifier is not configured');
  const id = flow.action!.id;
  let state = await ctx.verifier.inspect(id);
  if (state.state === 'missing') {
    const workspace = await getWorkspace(ctx, task.id);
    if (workspace.state !== 'ready' || workspace.location.dirty) throw new ExecutionError('Verification requires a ready, clean Task worktree');
    for (const ref of flow.artifact_refs) {
      const artifact = await ctx.store.get('artifact', { ref });
      if (artifact?.code && artifact.code.head_sha !== workspace.location.head) throw new ExecutionError('Verification worktree differs from pinned Artifact');
    }
    await ctx.verifier.prepare({ id, workdir: workspace.location.workdir, head: workspace.location.head, commands });
    state = await ctx.verifier.inspect(id);
  }
  // Observe the reserved execution before inspecting the live worktree: even a check
  // that changed files must have its completed failure collected, without rerunning it.
  if (state.state === 'prepared') state = await ctx.verifier.submit(id);
  if (state.state !== 'completed') return state;
  const result = state.result;
  rejectIf(schemaIssues('verification-result', result, 'verification'));
  if (result.id !== id || result.checks.length !== commands.length || result.checks.some((c, i) => c.name !== commands[i]!.name) || result.verdict !== (result.checks.every(c => c.result === 'pass') ? 'pass' : 'fail')) throw new ExecutionError('Verification receipt differs from declared checks');
  await move(ctx, task, async (_task, next) => c => {
    delete next.action; next.verification = result;
    if (result.verdict === 'pass' && step.verify.semantic?.length) { next.phase = 'reviewer'; return { flow: next }; }
    const gate: GateResult = { id: c.nextId('gate_result'), task_id: task.id, step_id: step.id, artifact_refs: next.artifact_refs, verdict: result.verdict, checks: result.checks, created_at: recordedAt(ctx.clock) };
    next.gate_id = gate.id;
    const extras: Extras = { writes: [{ kind: 'gate_result', value: gate }], events: [{ type: 'gate.completed', actor: 'system', step_id: step.id, ref: gate.id, data: { verdict: gate.verdict }, ...tail(ctx, recordedAt(ctx.clock)) }] };
    acceptGate(ctx, next, step, gate, extras);
    return { flow: next, extras };
  });
  return true;
}

function transition(ctx: WorkflowContext, step: Step, command: Parameters<typeof nextStepStatus>[0], extras: Extras): Step {
  const status = nextStepStatus(command, step.status, step.id);
  extras.events ??= []; extras.writes ??= [];
  extras.events.push(...statusChangedEvents(step.id, [step.status, status], tail(ctx, recordedAt(ctx.clock))));
  const next = { ...step, status };
  // One final Step write per commit.
  extras.writes = extras.writes.filter(w => w.kind !== 'step'); extras.writes.push({ kind: 'step', value: next });
  return next;
}
function closeStep(ctx: WorkflowContext, flow: Workflow, step: Step, gate: GateResult, extras: Extras) {
  let next = transition(ctx, step, 'approveStep', extras); next = transition(ctx, next, 'approveStep', extras);
  for (const ref of flow.artifact_refs) extras.events!.push({ type: 'artifact.approved', actor: ctx.actor, step_id: step.id, ref, data: { gate: gate.id }, ...tail(ctx, recordedAt(ctx.clock)) });
  flow.phase = 'planner'; delete flow.pending; delete flow.action; delete flow.revision;
  delete flow.verification; delete flow.gate_id;
}
function acceptGate(ctx: WorkflowContext, flow: Workflow, step: Step, gate: GateResult, extras: Extras) {
  const checked = transition(ctx, step, gate.verdict === 'pass' ? 'recordGate(pass)' : 'recordGate(fail)', extras);
  if (gate.verdict === 'fail') { flow.phase = 'worker'; delete flow.pending; delete flow.verification; return; }
  if (step.approval === 'optional' && step.verify.deterministic?.length) closeStep({ ...ctx, actor: 'system' }, flow, checked, gate, extras);
  else {
    flow.phase = 'artifact_approval';
    flow.pending = { id: randomUUID(), role: 'artifact', step_id: step.id, gate_id: gate.id, artifact_refs: [...flow.artifact_refs] };
    extras.events!.push({ type: 'hitl.waiting', actor: 'system', data: { target: flow.pending }, ...tail(ctx, recordedAt(ctx.clock)) });
  }
}

export async function respondHitl(ctx: WorkflowContext, input: { taskId: string; target: HitlTarget; response: 'approve' | 'revise'; text?: string; destination?: 'worker' | 'reviewer' }) {
  checkKeys(input, ['taskId', 'target', 'response', 'text', 'destination']); humanId(ctx);
  rejectIf(schemaIssues('hitl-target', input.target, 'target'));
  if (!['approve', 'revise'].includes(input.response)) throw new ExecutionError('Choose approve or revise');
  if (input.response === 'revise' && !input.text?.trim()) throw new ExecutionError('Revision text is required');
  if (input.destination && (input.target.role !== 'reviewer' || input.response !== 'revise' || !['worker', 'reviewer'].includes(input.destination))) throw new ExecutionError('Only Reviewer revisions select worker or reviewer');
  if (input.target.role === 'reviewer' && input.response === 'revise' && !input.destination) throw new ExecutionError('Select worker for artifact changes, reviewer for reconsidering the judgment');
  const text = input.text?.trim() || 'Approved';
  const events = await ctx.store.readEvents(input.taskId);
  const previous = events.find(e => e.type === 'hitl.responded' && (e.data as { target?: HitlTarget } | undefined)?.target?.id === input.target.id);
  if (previous) {
    if (!sameJson(previous.data, { target: input.target, response: input.response, text, ...(input.destination ? { destination: input.destination } : {}) }) || previous.actor !== ctx.actor) throw new ExecutionError('This HITL result already has a different response');
    // An identical retry is a receipt lookup, never another advance.
    return getWorkflow(ctx, input.taskId);
  }
  const task = await openTask(ctx, input.taskId);
  try { await respond(ctx, task, input.target, input.response, text, input.destination, true); }
  catch (error) { if (error instanceof Moved) throw new ExecutionError('HITL target is stale; refresh the current result'); throw error; }
  return advance(ctx, { taskId: input.taskId });
}

async function respond(ctx: WorkflowContext, task: Task, target: HitlTarget, response: 'approve' | 'revise', text: string, destination: 'worker' | 'reviewer' | undefined, human: boolean) {
  if (!sameJson(task.workflow?.pending, target)) throw new ExecutionError('HITL target is stale; refresh the current result');
  await move(ctx, task, async (_task, flow) => {
    const reasons: string[] = [];
    for (const ref of target.artifact_refs) await checkArtifactRef(ctx, ref, { taskId: task.id, ...(target.step_id && target.role !== 'planner' ? { stepId: target.step_id } : {}) }, 'target.artifact_refs', reasons);
    rejectIf(reasons);
    const step = target.step_id ? await ctx.store.get('step', { taskId: task.id, stepId: target.step_id }) : undefined;
    const decision = target.decision_id ? await ctx.store.get('decision', { taskId: task.id, id: target.decision_id }) : undefined;
    const gate = target.gate_id && step ? await ctx.store.get('gate_result', { taskId: task.id, stepId: step.id, id: target.gate_id }) : undefined;
    if (gate && !sameJson(gate.artifact_refs, target.artifact_refs)) throw new ExecutionError('Gate version mismatch');
    return c => {
      const extras: Extras = { writes: [], events: [{ type: 'hitl.responded', actor: human ? ctx.actor : 'system', data: { target, response, text, ...(destination ? { destination } : {}) }, ...tail(ctx, recordedAt(ctx.clock)) }] };
      delete flow.pending; delete flow.action;
      if (human) {
        const refs = target.artifact_refs.length ? target.artifact_refs : [undefined];
        for (const ref of refs) {
          const feedback: Feedback = { id: c.nextId('feedback'), task_id: task.id, ...(step ? { step_id: step.id } : {}),
            kind: response === 'revise' ? 'revision_request' : target.role === 'artifact' ? 'approval' : 'direction', channel: target.role === 'planner' ? 'plan' : 'review',
            target: { ...(ref ? { artifact_ref: ref } : {}), ...(target.run_id ? { run_id: target.run_id } : {}), ...(decision ? { decision_id: decision.id } : {}) },
            text, author: humanId(ctx), created_at: recordedAt(ctx.clock) };
          extras.writes!.push({ kind: 'feedback', value: feedback });
          extras.events!.push({ type: 'feedback.added', actor: ctx.actor, ref: feedback.id, data: { kind: feedback.kind }, ...tail(ctx, recordedAt(ctx.clock)) });
        }
      }
      if (response === 'revise') {
        const role = target.role === 'planner' ? 'planner' : destination ?? 'worker';
        flow.revision = { target, text, destination: role }; flow.phase = role;
        if (role === 'planner' && step) transition(ctx, step, 'cancelStep', extras);
        if (role === 'worker' && step) { transition(ctx, step, step.status === 'in_review' ? 'requestRevision' : 'reviseResult', extras); delete flow.verification; delete flow.gate_id; }
      } else if (target.role === 'planner') {
        if (!decision) throw new ExecutionError('Planner Decision is missing');
        if (decision.action === 'next_step' && step) {
          const defined = transition(ctx, step, 'defineStep', extras);
          if (!defined.verify.deterministic?.length) { defined.approval = 'required'; }
          extras.events!.push({ type: 'step.defined', actor: human ? ctx.actor : 'system', step_id: step.id, ref: decision.id, data: { human_edit: false }, ...tail(ctx, recordedAt(ctx.clock)) });
          flow.phase = 'worker';
        } else if (decision.action === 'done') flow.phase = 'ready_to_complete';
        else {
          flow.phase = 'paused'; flow.reason = `Planner ${decision.action}: ${decision.rationale}. Request a revised plan from this result when ready.`;
          // The accepted proposal and the subsequent planning request are different decisions.
          flow.pending = { ...target, id: randomUUID() };
        }
      } else if (target.role === 'worker') flow.phase = 'verification';
      else if (target.role === 'reviewer') {
        if (!gate || !step) throw new ExecutionError('Reviewer Gate/Step is missing');
        acceptGate(ctx, flow, step, gate, extras);
      } else {
        if (!gate || !step || gate.verdict !== 'pass') throw new ExecutionError('Final Artifact approval requires a passing current Gate');
        closeStep(ctx, flow, step, gate, extras);
      }
      return { flow, extras };
    };
  });
}
