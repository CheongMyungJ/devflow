// 사람이 산출물을 보고 하는 일 (docs/design/commands.md 6.1·6.2·6.3, 7절): requestRevision, approveStep, addFeedback.
// 한 기록은 한 command — approval 은 approveStep, revision_request 는 requestRevision, 나머지 kind 는 addFeedback 이 쓴다.

import { isCanonicalId, isGateId, parseArtifactRef } from '../store/refs.js';
import type { CommitResult, EntityWrite, NewEvent } from '../store/types.js';
import type { Feedback, Step } from '../types/generated/index.js';
import { checkArtifactRef, checkKeys, commitAfterReading, humanId, openTask, rejectIf, tail } from './common.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { recordedAt } from './time.js';
import { nextStepStatus, statusChangedEvents } from './transitions.js';

async function stepOf(ctx: CommandContext, taskId: string, stepId: string): Promise<Step> {
  const step = isCanonicalId('step', stepId) ? await ctx.store.get('step', { taskId, stepId }) : undefined;
  if (step === undefined) throw new RejectedInputError([`stepId: ${taskId} 에 ${stepId} 가 없다`]);
  return step;
}

const nonEmpty = (text: unknown, label: string) => {
  if (typeof text !== 'string' || text.trim() === '') throw new RejectedInputError([`${label}: 비어 있다`]);
};

// ---------------------------------------------------------------- requestRevision

export interface RequestRevisionInput {
  taskId: string;
  stepId: string;
  /** 사람이 본 산출물의 버전. 이 Step 의 것이고 있으며 그 이름의 가장 새 버전이어야 한다. */
  artifactRef: string;
  text: string;
}

/** 사람의 수정 요청: Feedback(revision_request, review), feedback.added, step.yaml(in_review → revising)과 step.status_changed — 한 commit. */
export async function requestRevision(ctx: CommandContext, input: RequestRevisionInput): Promise<{ feedback: Feedback; result: CommitResult }> {
  checkKeys(input, ['taskId', 'stepId', 'artifactRef', 'text']);
  const author = humanId(ctx);
  nonEmpty(input.text, 'text');
  const { taskId, stepId } = input;
  const at = recordedAt(ctx.clock);
  let feedback!: Feedback;
  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    const step = await stepOf(ctx, taskId, stepId);
    const next = nextStepStatus('requestRevision', step.status, stepId);
    const reasons: string[] = [];
    await checkArtifactRef(ctx, input.artifactRef, { taskId, stepId }, 'artifactRef', reasons);
    rejectIf(reasons);
    return (c) => {
      const id = c.nextId('feedback');
      feedback = { id, task_id: taskId, step_id: stepId, kind: 'revision_request', channel: 'review', target: { artifact_ref: input.artifactRef }, text: input.text, author, created_at: at };
      return {
        writes: [
          { kind: 'feedback', value: feedback },
          { kind: 'step', value: { ...step, status: next } },
        ],
        events: [
          { type: 'feedback.added', actor: ctx.actor, step_id: stepId, ref: id, data: { kind: 'revision_request' }, ...tail(ctx, at) },
          ...statusChangedEvents(stepId, [step.status, next], tail(ctx, at)),
        ] as [NewEvent, ...NewEvent[]],
      };
    };
  });
  return { feedback, result };
}

// ---------------------------------------------------------------- approveStep

export interface ApproveStepInput {
  taskId: string;
  stepId: string;
  /** 사람이 본 Gate. 필수(T-0006 F-001 (2)) — 그 Gate 의 artifact_refs 가 사람이 본 버전이다. */
  gateId: string;
  /** 사람의 말과 받아들인 권고·한계. 산출물마다의 승인 Feedback 에 들어간다. */
  text: string;
}

/**
 * 승인: 산출물마다 Feedback(approval, review), step.yaml(closed), feedback.added×N, artifact.approved×N(data.gate),
 * step.status_changed in_review → approved(data.official_gate) → closed — 한 commit. Artifact meta 는 고치지 않는다(ADR-0015).
 * 그 Gate 가 이 Step 의 것이고 pass 이며, 그 artifact_refs 가 Step 의 outputs 이름마다 하나씩이고 각각이 그 이름의 가장 새 버전일 때만
 * 그 버전들을 승인한다 — 사람이 본 뒤에 새 버전이 생겼으면 아무것도 쓰지 않고 거부한다(AGENTS.md 8번, commands.md 4절).
 */
export async function approveStep(ctx: CommandContext, input: ApproveStepInput): Promise<{ feedback: Feedback[]; approved: string[]; result: CommitResult }> {
  checkKeys(input, ['taskId', 'stepId', 'gateId', 'text']);
  const author = humanId(ctx);
  nonEmpty(input.text, 'text');
  const { taskId, stepId, gateId } = input;
  if (gateId === undefined) throw new RejectedInputError(['gateId: 사람이 본 Gate 를 준다 (--gate G-NNN, T-0006 F-001 (2))']);
  if (!isGateId(gateId)) throw new RejectedInputError([`gateId: ${JSON.stringify(gateId)} 는 G-NNN 의 정규형이 아니다`]);
  const at = recordedAt(ctx.clock);
  let feedback: Feedback[] = [];
  let approved: string[] = [];

  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    const step = await stepOf(ctx, taskId, stepId);
    const approvedStatus = nextStepStatus('approveStep', step.status, stepId);
    const closed = nextStepStatus('approveStep', approvedStatus, stepId);
    const gate = await ctx.store.get('gate_result', { taskId, stepId, id: gateId });
    if (gate === undefined) throw new RejectedInputError([`gateId: ${stepId} 에 ${gateId} 가 없다`]);
    const reasons: string[] = [];
    if (gate.verdict !== 'pass') reasons.push(`gateId: ${gateId} 는 ${gate.verdict} 다 — pass 인 Gate 로만 승인한다`);
    const outputs = step.outputs.map((o) => o.name);
    const byName = new Map<string, string[]>();
    for (const ref of gate.artifact_refs) {
      const name = parseArtifactRef(ref)?.name ?? ref;
      byName.set(name, [...(byName.get(name) ?? []), ref]);
    }
    for (const name of outputs) {
      const refs = byName.get(name) ?? [];
      if (refs.length !== 1) reasons.push(`gateId: ${gateId} 의 artifact_refs 에 ${name} 이 ${refs.length} 개다 — outputs 이름마다 하나여야 한다`);
    }
    for (const name of byName.keys()) if (!outputs.includes(name)) reasons.push(`gateId: ${gateId} 의 artifact_refs 의 ${name} 은 ${stepId} 의 outputs 에 없다`);
    rejectIf(reasons);
    const refs = outputs.map((name) => byName.get(name)![0]!);
    for (const ref of refs) await checkArtifactRef(ctx, ref, { taskId, stepId }, `${gateId}.artifact_refs`, reasons);
    rejectIf(reasons);

    return (c) => {
      feedback = refs.map((ref) => ({ id: c.nextId('feedback'), task_id: taskId, step_id: stepId, kind: 'approval', channel: 'review', target: { artifact_ref: ref }, text: input.text, author, created_at: at }));
      approved = refs;
      const writes: EntityWrite[] = [...feedback.map((f): EntityWrite => ({ kind: 'feedback', value: f })), { kind: 'step', value: { ...step, status: closed } }];
      const events: NewEvent[] = [
        ...feedback.map((f): NewEvent => ({ type: 'feedback.added', actor: ctx.actor, step_id: stepId, ref: f.id, data: { kind: 'approval' }, ...tail(ctx, at) })),
        ...refs.map((ref): NewEvent => ({ type: 'artifact.approved', actor: ctx.actor, step_id: stepId, ref, data: { gate: gateId }, ...tail(ctx, at) })),
        ...statusChangedEvents(stepId, [step.status, approvedStatus, closed], tail(ctx, at), { official_gate: gateId }),
      ];
      return { writes, events: events as [NewEvent, ...NewEvent[]] };
    };
  });
  return { feedback, approved, result };
}

// ---------------------------------------------------------------- addFeedback

/** addFeedback 이 받는 kind. approval 은 approveStep, revision_request 는 requestRevision 이 쓴다. */
export const ADDABLE_FEEDBACK_KINDS = ['question', 'direction', 'requirement', 'answer'] as const;

export interface AddFeedbackInput {
  taskId: string;
  stepId?: string;
  kind: (typeof ADDABLE_FEEDBACK_KINDS)[number];
  channel: Feedback['channel'];
  target?: { artifactRef?: string; location?: string; runId?: string; decisionId?: string };
  text: string;
}

/** 질문·실행 중 지시·요구사항·답: Feedback, feedback.added(data.kind, data.channel) — 한 commit. Step 의 status 는 그대로. */
export async function addFeedback(ctx: CommandContext, input: AddFeedbackInput): Promise<{ feedback: Feedback; result: CommitResult }> {
  checkKeys(input, ['taskId', 'stepId', 'kind', 'channel', 'target', 'text']);
  if (input.target !== undefined) checkKeys(input.target, ['artifactRef', 'location', 'runId', 'decisionId'], 'target');
  const author = humanId(ctx);
  nonEmpty(input.text, 'text');
  if (!(ADDABLE_FEEDBACK_KINDS as readonly string[]).includes(input.kind)) {
    const kind: string = input.kind;
    const by = kind === 'approval' ? 'approveStep(approve-step)' : kind === 'revision_request' ? 'requestRevision(request-revision)' : undefined;
    throw new RejectedInputError([`kind: ${input.kind} 는 받지 않는다${by ? ` — ${by} 가 쓴다` : ''} (받는 것: ${ADDABLE_FEEDBACK_KINDS.join(', ')})`]);
  }
  const { taskId, stepId, target } = input;
  const at = recordedAt(ctx.clock);
  let feedback!: Feedback;
  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    if (stepId !== undefined) await stepOf(ctx, taskId, stepId);
    const reasons: string[] = [];
    if (target?.artifactRef !== undefined) await checkArtifactRef(ctx, target.artifactRef, { taskId, ...(stepId !== undefined ? { stepId } : {}) }, 'target.artifactRef', reasons, false);
    if (target?.runId !== undefined && !(isCanonicalId('run', target.runId) && (await ctx.store.get('run', { taskId, id: target.runId })))) reasons.push(`target.runId: ${taskId} 에 ${target.runId} 가 없다`);
    if (target?.decisionId !== undefined && !(isCanonicalId('decision', target.decisionId) && (await ctx.store.get('decision', { taskId, id: target.decisionId })))) reasons.push(`target.decisionId: ${taskId} 에 ${target.decisionId} 가 없다`);
    rejectIf(reasons);
    return (c) => {
      const id = c.nextId('feedback');
      const t = {
        ...(target?.artifactRef !== undefined ? { artifact_ref: target.artifactRef } : {}),
        ...(target?.location !== undefined ? { location: target.location } : {}),
        ...(target?.runId !== undefined ? { run_id: target.runId } : {}),
        ...(target?.decisionId !== undefined ? { decision_id: target.decisionId } : {}),
      };
      feedback = { id, task_id: taskId, ...(stepId !== undefined ? { step_id: stepId } : {}), kind: input.kind, channel: input.channel, ...(Object.keys(t).length ? { target: t } : {}), text: input.text, author, created_at: at };
      return {
        writes: [{ kind: 'feedback', value: feedback }],
        events: [{ type: 'feedback.added', actor: ctx.actor, ...(stepId !== undefined ? { step_id: stepId } : {}), ref: id, data: { kind: input.kind, channel: input.channel }, ...tail(ctx, at) }],
      };
    };
  });
  return { feedback, result };
}
