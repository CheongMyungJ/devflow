// Planner 의 출력과 사람의 Step 확정 (docs/design/commands.md 6.1·6.2·6.3, 7절): recordDecision, defineStep.

import { isCanonicalId } from '../store/refs.js';
import type { CommitResult, EntityWrite, NewEvent } from '../store/types.js';
import type { Decision, Run, Step } from '../types/generated/index.js';
import { checkKeys, commitAfterReading, humanId, isPositiveInteger, openTask, rejectIf, sameJson, schemaIssues, tail, withNote } from './common.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { submittedRun } from './runs.js';
import { recordedAt } from './time.js';
import { nextStepStatus, statusChangedEvents } from './transitions.js';

// ---------------------------------------------------------------- recordDecision

export interface RecordDecisionInput {
  taskId: string;
  /** Planner 의 Run(submitted, Task 수준). */
  runId: string;
  /** Planner 의 출력(Decision 모양)을 읽은 값. 도구가 id·task_id·planner_run_id·created_at 을 채워 넣는다(Planner 가 적은 값은 바뀐다). */
  output: unknown;
  /** 그 출력 파일의 원문. blob R-NNN.output.yaml 로 그대로 남는다. */
  outputText: string;
  outputAttempts?: number;
  note?: string;
}

/** Decision 에서 도구가 채우는 필드 — Planner 의 값은 원문(blob)에만 남는다. */
const DECISION_TOOL_FILLED = ['id', 'task_id', 'planner_run_id', 'created_at'] as const;

/**
 * Planner 의 출력을 받아들인다: blob R-NNN.output.yaml(원문), Decision, Run(completed, ended_at, packet_gaps ← Decision 의 packet_gaps, output_attempts),
 * run.completed, decision.made, next_step 이고 step 이 있으면 step.yaml(proposed, created_from)과 step.proposed — 한 commit.
 * next_step 이면(step 이든 skill 이든) 닫히지 않은 Step 이 있을 때 거부한다. skill 만인 next_step 은 Decision 만 쓰고 Step 을 만들지 않는다.
 * step.status_changed 는 쓰지 않는다: proposed 는 step.proposed 가 정한다(commands.md 6절 원칙의 "status 를 정한 마지막 이벤트").
 * action 이 done·ask_human·abort·rework 이면 Task·Step 의 status 는 바꾸지 않는다.
 */
export async function recordDecision(ctx: CommandContext, input: RecordDecisionInput): Promise<{ decision: Decision; step?: Step; result: CommitResult }> {
  checkKeys(input, ['taskId', 'runId', 'output', 'outputText', 'outputAttempts', 'note']);
  const { taskId, runId } = input;
  if (typeof input.output !== 'object' || input.output === null || Array.isArray(input.output)) throw new RejectedInputError(['output: Decision 모양의 객체여야 한다']);
  if (input.outputAttempts !== undefined && !isPositiveInteger(input.outputAttempts)) throw new RejectedInputError(['outputAttempts: 1 이상의 정수여야 한다']);
  const given = input.output as Record<string, unknown>;
  const isNextStep = given['action'] === 'next_step';
  const proposal = isNextStep ? (given['next_step'] as { step?: unknown } | undefined)?.step : undefined;
  const at = recordedAt(ctx.clock);
  let decision!: Decision;
  let step: Step | undefined;

  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    const run = await submittedRun(ctx, taskId, runId, 'planner');
    if (isNextStep) {
      // step 이든 skill 이든 next_step 이면 — Step 은 하나씩 돈다(commands.md 6.3).
      const { items } = await ctx.store.list('step', { taskId });
      const open = items.filter((s) => s.status !== 'closed' && s.status !== 'cancelled');
      if (open.length) throw new RejectedInputError([`output.next_step: 닫히지 않은 Step(${open.map((s) => `${s.id} ${s.status}`).join(', ')})이 있다 — Step 은 하나씩 돈다`]);
    }
    if (proposal !== undefined) nextStepStatus('recordDecision', null, 'next_step');

    return (c) => {
      const id = c.nextId('decision');
      const rest = Object.fromEntries(Object.entries(given).filter(([k]) => !(DECISION_TOOL_FILLED as readonly string[]).includes(k)));
      decision = { id, task_id: taskId, ...rest, planner_run_id: runId, created_at: at } as Decision;
      rejectIf(schemaIssues('decision', decision, `decision ${id}`));
      const writes: EntityWrite[] = [{ kind: 'decision', value: decision }];
      const events: NewEvent[] = [
        { type: 'run.completed', actor: 'role:planner', run_id: runId, ...(input.note !== undefined ? { data: { note: input.note } } : {}), ...tail(ctx, at) },
        { type: 'decision.made', actor: 'role:planner', run_id: runId, ref: id, data: { action: decision.action }, ...tail(ctx, at) },
      ];
      if (proposal !== undefined) {
        const stepId = c.nextId('step');
        step = { id: stepId, task_id: taskId, ...(proposal as object), status: 'proposed', created_from: id } as Step;
        rejectIf(schemaIssues('step', step, `step ${stepId} (from ${id}.next_step.step)`));
        writes.push({ kind: 'step', value: step });
        events.push({ type: 'step.proposed', actor: 'system', step_id: stepId, ref: id, ...tail(ctx, at) });
      }
      const done: Run = {
        ...run,
        status: 'completed',
        ...(input.outputAttempts !== undefined ? { output_attempts: input.outputAttempts } : {}),
        ended_at: at,
        ...(decision.packet_gaps !== undefined ? { packet_gaps: decision.packet_gaps } : {}),
      };
      writes.push({ kind: 'run', value: done });
      return { writes, blobs: [{ owner: { taskId, runId }, name: 'output.yaml', content: input.outputText }], events: events as [NewEvent, ...NewEvent[]] };
    };
  });
  return { decision, ...(step !== undefined ? { step } : {}), result };
}

// ---------------------------------------------------------------- defineStep

export interface DefineStepInput {
  taskId: string;
  stepId: string;
  /** 사람이 고친 Step 정의(id·task_id·status·created_from 없이). 없으면 제안 그대로. */
  definition?: unknown;
  note?: string;
}

const STEP_TOOL_FILLED = ['id', 'task_id', 'status', 'created_from'];

/** Step 의 정의 부분(도구가 채우는 필드를 뺀 것). */
const definitionOf = (step: Record<string, unknown>) => Object.fromEntries(Object.entries(step).filter(([k]) => !STEP_TOOL_FILLED.includes(k)));

/**
 * 사람의 Step 확정: step.yaml(defined, 사람이 고친 정의의 반영), step.defined(data.human_edit, data.note), step.status_changed(proposed → defined) — 한 commit.
 * human_edit 은 도구가 정한다 — 확정한 정의가 created_from Decision 의 next_step.step 과 값이 다르면 true(created_from 이 없는 옛 Step 은 지금 정의와 비교).
 */
export async function defineStep(ctx: CommandContext, input: DefineStepInput): Promise<{ step: Step; humanEdit: boolean; result: CommitResult }> {
  checkKeys(input, ['taskId', 'stepId', 'definition', 'note']);
  humanId(ctx);
  const { taskId, stepId } = input;
  if (input.definition !== undefined) {
    if (typeof input.definition !== 'object' || input.definition === null || Array.isArray(input.definition)) throw new RejectedInputError(['definition: Step 정의의 객체여야 한다']);
    const reasons = Object.keys(input.definition).filter((k) => STEP_TOOL_FILLED.includes(k)).map((k) => `definition.${k}: 도구가 채우는 필드다 — 고친 정의에 두지 않는다`);
    rejectIf(reasons);
  }
  const at = recordedAt(ctx.clock);
  let step!: Step;
  let humanEdit = false;

  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    const current = isCanonicalId('step', stepId) ? await ctx.store.get('step', { taskId, stepId }) : undefined;
    if (current === undefined) throw new RejectedInputError([`stepId: ${taskId} 에 ${stepId} 가 없다`]);
    const next = nextStepStatus('defineStep', current.status, stepId);
    let proposed: unknown = definitionOf(current as unknown as Record<string, unknown>);
    if (current.created_from !== undefined) {
      const decision = await ctx.store.get('decision', { taskId, id: current.created_from });
      if (decision?.next_step?.step !== undefined) proposed = decision.next_step.step;
    }
    const definition = input.definition ?? definitionOf(current as unknown as Record<string, unknown>);
    humanEdit = input.definition !== undefined && !sameJson(definition, proposed);
    step = {
      id: stepId,
      task_id: taskId,
      ...(definition as object),
      status: next,
      ...(current.created_from !== undefined ? { created_from: current.created_from } : {}),
    } as Step;
    rejectIf(schemaIssues('step', step, `step ${stepId} (definition)`));

    return () => ({
      writes: [{ kind: 'step', value: step }],
      events: [
        {
          type: 'step.defined',
          actor: ctx.actor,
          step_id: stepId,
          ...(current.created_from !== undefined ? { ref: current.created_from } : {}),
          data: withNote({ human_edit: humanEdit }, input.note),
          ...tail(ctx, at),
        },
        ...statusChangedEvents(stepId, [current.status, next], tail(ctx, at)),
      ] as [NewEvent, ...NewEvent[]],
    });
  });
  return { step, humanEdit, result };
}
