// recordGate: Reviewer 의 출력을 받아들여 Gate 를 기록한다 (docs/design/commands.md 6.1·6.2·6.3·6.4, 7절).
// 옛 scripts/record-gate.mjs 의 검증 1~5 를 가져왔고, Run 과 Gate 를 한 commit 에 쓰므로 "Run 만 고쳐진 채 죽는" 경우가 없다.

import { isGateId } from '../store/refs.js';
import type { BlobWrite, CommitResult, NewEvent } from '../store/types.js';
import type { GateResult, Run, RunnerLocalResult } from '../types/generated/index.js';
import { completionFields } from '../runner/completion.js';
import { checkArtifactRef, checkKeys, commitAfterReading, duplicates, isPositiveInteger, openTask, parseJson, rejectIf, schemaIssues, tail } from './common.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { submittedRun } from './runs.js';
import { recordedAt } from './time.js';
import { nextStepStatus, statusChangedEvents } from './transitions.js';

export interface RecordGateInput {
  receipt?: RunnerLocalResult['outcome'];
  taskId: string;
  stepId: string;
  /** G-NNN 의 정규형이고 다음에 발급될 id 와 같아야 한다. 생략하면 도구가 발급한다. */
  gateId?: string;
  reviewerRunId: string;
  /** Reviewer 가 본 산출물. 참조마다 이 Step 의 것이고 있으며 그 이름의 가장 새 버전이어야 한다. */
  artifactRefs: readonly string[];
  /** Reviewer 의 출력 파일(reviewer-output JSON) 원문. blob R-NNN.output.json 으로 남는다. */
  output: string;
  /** Reviewer 가 아닌 출처의 정보(GateResult 의 annotations). 하나 이상. Gate 에 담기고 blob G-NNN.annotations.json 으로도 남는다. */
  annotations?: unknown;
  /** deterministic 검사의 결과 문서. Gate 와 같은 commit 에 blob G-NNN.deterministic 으로 쓴다(T-0006 F-001 2-가). */
  deterministic?: string;
  /** 출력이 거부되어 다시 받은 횟수를 포함한 시도 수(1 이상) — Reviewer Run 의 output_attempts. */
  outputAttempts?: number;
  note?: string;
}

type ReviewerOutput = Pick<GateResult, 'verdict' | 'checks'> & { done_when: NonNullable<GateResult['done_when']> } & { comments: Array<{ severity: string; class: string; text: string }>; packet_gaps: string[] };

/**
 * Gate 를 기록한다: Gate, Reviewer Run(completed, ended_at, packet_gaps ← 출력, output_attempts), blob R-NNN.output.json·G-NNN.annotations.json·
 * G-NNN.deterministic, run.completed, gate.completed(data: verdict, class 별 수), step.yaml(pass → in_review, fail → revising)과 step.status_changed — 한 commit.
 *
 * 아무것도 쓰기 전에 거부한다: 옛 record-gate 의 검증 — (1) Run 이 있고 reviewer 이고 이 Step 의 것이며 submitted 다, Gate 가 이미 있지 않다(id 는 발급될 것과 같아야 한다),
 * (2) 출력이 reviewer-output 스키마에 맞는다, (3) class A 가 있으면 verdict 는 fail, (4) 만들어질 Gate 가 gate-result 스키마에 맞는다(YAML 로 쓰고 다시 읽는 것은 Store 의 일),
 * (5) 고쳐질 Run 이 run 스키마에 맞는다(Store 가 검사) — 그리고 gate id 의 모양, artifact 참조, 빈 annotations, 표에 없는 전이.
 */
export async function recordGate(ctx: CommandContext, input: RecordGateInput): Promise<{ gate: GateResult; result: CommitResult }> {
  checkKeys(input, ['taskId', 'stepId', 'gateId', 'reviewerRunId', 'artifactRefs', 'output', 'annotations', 'deterministic', 'outputAttempts', 'note', 'receipt']);
  const { taskId, stepId, reviewerRunId } = input;
  const at = recordedAt(ctx.clock);

  const shape: string[] = [];
  if (input.gateId !== undefined && !isGateId(input.gateId)) shape.push(`gateId: ${JSON.stringify(input.gateId)} 는 G-NNN 의 정규형이 아니다 (예 G-001)`);
  if (input.outputAttempts !== undefined && !isPositiveInteger(input.outputAttempts)) shape.push('outputAttempts: 1 이상의 정수여야 한다');
  if (input.annotations !== undefined && (!Array.isArray(input.annotations) || input.annotations.length === 0)) {
    shape.push('annotations: 하나 이상의 배열이어야 한다 (덧붙일 것이 없으면 주지 않는다)');
  }
  if (input.artifactRefs.length === 0) shape.push('artifactRefs: 하나 이상');
  for (const d of duplicates(input.artifactRefs)) shape.push(`artifactRefs: ${d} 가 두 번 있다`);
  rejectIf(shape);
  // (2)(3) Reviewer 출력
  const out = parseJson(input.output, 'output') as ReviewerOutput;
  rejectIf(schemaIssues('reviewer-output', out, 'output'));
  const classA = out.comments.flatMap((c, i) => (c.class === 'A' ? [`output/comments/${i}/class is A`] : []));
  if (classA.length && out.verdict !== 'fail') throw new RejectedInputError([`output: verdict is ${out.verdict} but there are class A findings (A 가 하나라도 있으면 verdict 는 fail 이어야 한다)`, ...classA]);

  let gate!: GateResult;
  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    const step = await ctx.store.get('step', { taskId, stepId });
    if (step === undefined) throw new RejectedInputError([`stepId: ${taskId} 에 ${stepId} 가 없다`]);
    // (1) Run
    const run = await submittedRun(ctx, taskId, reviewerRunId, 'reviewer', stepId);
    const next = nextStepStatus(out.verdict === 'pass' ? 'recordGate(pass)' : 'recordGate(fail)', step.status, stepId);
    const reasons: string[] = [];
    for (const [i, ref] of input.artifactRefs.entries()) await checkArtifactRef(ctx, ref, { taskId, stepId }, `artifactRefs[${i}]`, reasons);
    rejectIf(reasons);

    return (c) => {
      const id = c.nextId('gate_result');
      if (input.gateId !== undefined && input.gateId !== id) throw new RejectedInputError([`gateId: 다음에 발급될 Gate id 는 ${id} 다 (받은 것 ${input.gateId}) — 번호를 건너뛰거나 이미 있는 Gate 를 덮어쓰지 않는다`]);
      gate = {
        id,
        task_id: taskId,
        step_id: stepId,
        artifact_refs: [...input.artifactRefs] as GateResult['artifact_refs'],
        verdict: out.verdict,
        checks: out.checks,
        done_when: out.done_when,
        comments: out.comments as NonNullable<GateResult['comments']>,
        ...(input.annotations !== undefined ? { annotations: input.annotations as NonNullable<GateResult['annotations']> } : {}),
        reviewer_run_id: reviewerRunId,
        created_at: at,
      };
      // (4) 만들어질 Gate — Store 도 검사하지만, 거부 문구를 옛 record-gate 처럼 위치와 함께 보인다.
      rejectIf(schemaIssues('gate-result', gate, `gate ${id} (to be written${input.annotations !== undefined ? ', annotations from input' : ''})`));
      const done: Run = { ...run, ...completionFields(input.receipt), status: 'completed', ...(input.outputAttempts !== undefined ? { output_attempts: input.outputAttempts } : {}), ended_at: at, packet_gaps: out.packet_gaps };
      const runOwner = { taskId, stepId, runId: reviewerRunId };
      const gateOwner = { taskId, stepId, gateId: id };
      const blobs: BlobWrite[] = [{ owner: runOwner, name: 'output.json', content: input.output }];
      if (input.annotations !== undefined) blobs.push({ owner: gateOwner, name: 'annotations.json', content: `${JSON.stringify(input.annotations, null, 2)}\n` });
      if (input.deterministic !== undefined) blobs.push({ owner: gateOwner, name: 'deterministic', content: input.deterministic });
      const count = (k: string) => out.comments.filter((x) => x.class === k).length;
      const events: NewEvent[] = [
        { type: 'run.completed', actor: 'role:reviewer', step_id: stepId, run_id: reviewerRunId, ...(input.note !== undefined ? { data: { note: input.note } } : {}), ...tail(ctx, at) },
        {
          type: 'gate.completed',
          actor: 'role:reviewer',
          step_id: stepId,
          run_id: reviewerRunId,
          ref: id,
          data: { verdict: out.verdict, class_a: count('A'), class_b: count('B'), class_c: count('C') },
          ...tail(ctx, at),
        },
        ...statusChangedEvents(stepId, [step.status, next], tail(ctx, at)),
      ];
      return {
        writes: [
          { kind: 'gate_result', value: gate },
          { kind: 'run', value: done },
          { kind: 'step', value: { ...step, status: next } },
        ],
        blobs,
        events: events as [NewEvent, ...NewEvent[]],
      };
    };
  });
  return { gate, result };
}
