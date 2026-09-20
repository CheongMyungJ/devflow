// Run 을 제출·완료·실패로 기록하는 command (docs/design/commands.md 6.1·6.2·6.3, 7절): submitRun, completeRun(Worker), failRun.
// Reviewer 의 Run 은 recordGate, Planner 의 Run 은 recordDecision 이 닫는다.

import { blobRef } from '../store/blob-ref.js';
import { artifactRef, isCanonicalId } from '../store/refs.js';
import type { BlobOwner, BlobWrite, CommitResult, EntityWrite, NewEvent } from '../store/types.js';
import type { ArtifactVersion, Run, Step, WorkerExecutionInput } from '../types/generated/index.js';
import {
  checkKeys,
  commitAfterReading,
  duplicates,
  isPositiveInteger,
  isSha,
  openTask,
  parseJson,
  rejectIf,
  schemaIssues,
  tail,
  withNote,
} from './common.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { recordedAt } from './time.js';
import { nextStepStatus, statusChangedEvents } from './transitions.js';

// ---------------------------------------------------------------- submitRun

export interface SubmitRunInput {
  /** 실행 command 내부용: 로컬 prepare 뒤 입력 blob과 함께 기록한다. */
  execution?: NonNullable<Run['execution']>;
  executionInput?: WorkerExecutionInput;
  taskId: string;
  /** worker·reviewer 는 필수, planner 는 없다(Task 수준). */
  stepId?: string;
  /** intake 는 받지 않는다 — intake Run 을 닫는 command 가 없다(T-0006 G-001 B, commands.md 6.3). */
  role: Run['role'];
  purpose?: Run['purpose'];
  access: Run['access'];
  backend: string;
  backendVersion?: string;
  model?: string;
  backendSessionId?: string;
  sessionPath: Run['session_path'];
  performer?: Run['performer'];
  /** 이어간 앞 Run. sessionPath 가 resumed·resume_failed_new 일 때만, 그리고 그때는 필수. */
  resumedFrom?: string;
  /** 발급될 Run id 가 이것과 다르면 거부한다(패킷에 Run id 를 먼저 적는 흐름). */
  expectId?: string;
  /** Context 패킷 원문. blob R-NNN.packet 으로 남는다. */
  packet?: string;
  note?: string;
}

const SUBMIT_KEYS = ['taskId', 'stepId', 'role', 'purpose', 'access', 'backend', 'backendVersion', 'model', 'backendSessionId', 'sessionPath', 'performer', 'resumedFrom', 'expectId', 'packet', 'note', 'execution', 'executionInput'];

/**
 * Run 을 제출로 기록한다: Run(submitted), blob R-NNN.packet(주어지면), run.submitted, worker 가 defined 에서 부르면 step.yaml(running)과
 * step.status_changed — 한 commit. Run id·submitted_at·system_sha·status 는 도구가 채운다.
 */
export async function submitRun(ctx: CommandContext, input: SubmitRunInput): Promise<{ run: Run; result: CommitResult }> {
  checkKeys(input, SUBMIT_KEYS);
  if ((input.execution === undefined) !== (input.executionInput === undefined)) throw new RejectedInputError(['execution과 executionInput은 함께 필요하다']);
  if (input.executionInput) rejectIf(schemaIssues('worker-execution-input', input.executionInput, 'executionInput'));
  const { taskId, stepId, role } = input;
  const at = recordedAt(ctx.clock);
  let run!: Run;

  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    const reasons: string[] = [];
    if (role === 'intake') reasons.push('role: intake Run 은 받지 않는다 — intake Run 을 닫는 command 가 없다 (commands.md 6.3)');
    if ((role === 'worker' || role === 'reviewer') && stepId === undefined) reasons.push(`stepId: ${role} 의 Run 은 Step 에 속한다`);
    if (role === 'planner' && stepId !== undefined) reasons.push('stepId: planner 의 Run 은 Task 수준이다');
    if (input.expectId !== undefined && !isCanonicalId('run', input.expectId)) reasons.push(`expectId: ${input.expectId} 는 R-NNN 의 정규형이 아니다`);
    const resumes = input.sessionPath === 'resumed' || input.sessionPath === 'resume_failed_new';
    if (resumes && input.resumedFrom === undefined) reasons.push(`resumedFrom: session_path ${input.sessionPath} 이면 이어간 Run 을 준다`);
    if (!resumes && input.resumedFrom !== undefined) reasons.push(`resumedFrom: session_path ${input.sessionPath} 에는 주지 않는다`);
    if (input.resumedFrom !== undefined && (await ctx.store.get('run', { taskId, id: input.resumedFrom })) === undefined) reasons.push(`resumedFrom: ${taskId} 에 ${input.resumedFrom} 가 없다`);
    rejectIf(reasons);

    let step: Step | undefined;
    let next: Step['status'] | undefined;
    if (stepId !== undefined) {
      step = await ctx.store.get('step', { taskId, stepId });
      if (step === undefined) throw new RejectedInputError([`stepId: ${taskId} 에 ${stepId} 가 없다`]);
      next = nextStepStatus(role === 'worker' ? 'submitRun(worker)' : 'submitRun(reviewer)', step.status, stepId);
    }
    const { items: runs } = await ctx.store.list('run', { taskId, stepId: stepId ?? null, role });
    const open = runs.filter((r) => r.status === 'submitted');
    if (open.length) {
      throw new RejectedInputError([`role: ${stepId ?? taskId} 에 아직 submitted 인 ${role} Run(${open.map((r) => r.id).join(', ')})이 있다 — 먼저 완료하거나 failRun`]);
    }

    return (c) => {
      const id = c.nextId('run');
      if (input.expectId !== undefined && input.expectId !== id) throw new RejectedInputError([`expectId: 발급될 Run id 는 ${id} 다 (받은 것 ${input.expectId})`]);
      run = {
        id,
        task_id: taskId,
        ...(stepId !== undefined ? { step_id: stepId } : {}),
        role,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        access: input.access,
        backend: input.backend,
        ...(input.backendVersion !== undefined ? { backend_version: input.backendVersion } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.backendSessionId !== undefined ? { backend_session_id: input.backendSessionId } : {}),
        session_path: input.sessionPath,
        ...(input.resumedFrom !== undefined ? { resumed_from: input.resumedFrom } : {}),
        ...(input.performer !== undefined ? { performer: input.performer } : {}),
        status: 'submitted',
        ...(ctx.systemSha !== undefined ? { system_sha: ctx.systemSha } : {}),
        submitted_at: at,
        ...(input.execution ? { execution: input.execution } : {}),
      };
      const writes: EntityWrite[] = [{ kind: 'run', value: run }];
      if (step !== undefined && next !== step.status) writes.push({ kind: 'step', value: { ...step, status: next! } });
      const owner: BlobOwner = { taskId, ...(stepId !== undefined ? { stepId } : {}), runId: id };
      const blobs: BlobWrite[] = input.packet !== undefined ? [{ owner, name: 'packet', content: input.packet }] : [];
      if (input.executionInput) blobs.push({ owner, name: 'execution-input.json', content: JSON.stringify(input.executionInput) });
      const data = withNote(
        { role, backend: input.backend, ...(input.resumedFrom !== undefined ? { session_path: input.sessionPath, resumed_from: input.resumedFrom } : {}) },
        input.note,
      );
      const events: NewEvent[] = [
        { type: 'run.submitted', actor: 'system', ...(stepId !== undefined ? { step_id: stepId } : {}), run_id: id, data, ...tail(ctx, at) },
        ...(step !== undefined ? statusChangedEvents(stepId!, [step.status, next!], tail(ctx, at)) : []),
      ];
      return { writes, blobs, events: events as [NewEvent, ...NewEvent[]] };
    };
  });
  return { run, result };
}

// ---------------------------------------------------------------- completeRun

export interface ArtifactSource {
  /** Step 의 outputs 에 선언된 이름. */
  name: string;
  /**
   * `code:<base-sha>..<head-sha>`(code_change — repo·branch 는 Task 의 target 에서. 변경 전체라 paths 가 없어 stored_in 을 쓰지 않는다 —
   *   지금 스키마는 stored_in repo 에 paths 를 요구한다. 옛 기록 분기로 기록된다: commands.md 6.2),
   * `repo:<base-sha>..<head-sha>:<path>[,<path>…]`(대상 repo 안의 문서, stored_in repo),
   * `blob:<label>`(이 commit 의 blob — 지금은 work-notes 뿐, stored_in store).
   */
  source: string;
}

export interface CompleteRunInput {
  taskId: string;
  runId: string;
  /** Worker 의 출력 파일(worker-output JSON) 원문. 필수(T-0006 F-001 3-가) — Run 의 packet_gaps 는 여기서 옮긴다. blob R-NNN.output.json 으로 남는다. */
  workerOutput: string;
  /** 작업 노트 원문. blob R-NNN.work-notes 로 남는다. */
  workNotes?: string;
  artifacts: readonly ArtifactSource[];
  /** 출력이 거부되어 다시 받은 횟수를 포함한 시도 수(1 이상). */
  outputAttempts?: number;
  note?: string;
}

const COMPLETE_KEYS = ['taskId', 'runId', 'workerOutput', 'workNotes', 'artifacts', 'outputAttempts', 'note'];
const SHA = '[0-9a-f]{40}|[0-9a-f]{64}';
const CODE_SOURCE = new RegExp(`^code:(${SHA})\\.\\.(${SHA})$`);
const REPO_SOURCE = new RegExp(`^repo:(${SHA})\\.\\.(${SHA}):(.+)$`);
const BLOB_SOURCE = /^blob:([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/**
 * Worker 의 Run 을 완료로 기록한다: Run(completed, ended_at, packet_gaps ← worker-output, output_attempts), blob R-NNN.output.json·R-NNN.work-notes,
 * Artifact meta 들(버전은 도구가 발급), run.completed, artifact.version_added×N, step.yaml(running·revising → checking)과 step.status_changed — 한 commit.
 */
export async function completeRun(ctx: CommandContext, input: CompleteRunInput): Promise<{ artifacts: ArtifactVersion[]; result: CommitResult }> {
  checkKeys(input, COMPLETE_KEYS);
  const { taskId, runId } = input;
  const at = recordedAt(ctx.clock);
  const output = parseJson(input.workerOutput, 'workerOutput') as { summary: string; packet_gaps: string[] };
  rejectIf(schemaIssues('worker-output', output, 'workerOutput'));
  if (input.outputAttempts !== undefined && !isPositiveInteger(input.outputAttempts)) throw new RejectedInputError(['outputAttempts: 1 이상의 정수여야 한다']);
  let artifacts: ArtifactVersion[] = [];

  const result = await commitAfterReading(ctx, taskId, async () => {
    const task = await openTask(ctx, taskId);
    const run = await submittedRun(ctx, taskId, runId, 'worker');
    const stepId = run.step_id!;
    const step = (await ctx.store.get('step', { taskId, stepId }))!;
    const next = nextStepStatus('completeRun', step.status, stepId);

    const reasons: string[] = [];
    const declared = new Map(step.outputs.map((o) => [o.name, o.type]));
    const names = input.artifacts.map((a) => a.name);
    for (const d of duplicates(names)) reasons.push(`artifacts: ${d} 가 두 번 있다`);
    for (const name of names) if (!declared.has(name)) reasons.push(`artifacts: ${name} 는 ${stepId} 의 outputs 에 없다`);
    for (const name of declared.keys()) if (!names.includes(name)) reasons.push(`artifacts: ${stepId} 의 outputs 의 ${name} 가 빠졌다`);
    const owner: BlobOwner = { taskId, stepId, runId };
    const notesKey = input.workNotes !== undefined ? blobRef(owner, 'work-notes') : undefined;
    const shapes: Array<{ name: string; fields: Partial<ArtifactVersion> }> = [];
    for (const { name, source } of input.artifacts) {
      const type = declared.get(name);
      if (type === undefined) continue;
      const label = `artifacts[${name}]`;
      let m: RegExpExecArray | null;
      if ((m = CODE_SOURCE.exec(source))) {
        if (type !== 'code_change') reasons.push(`${label}: code: 는 code_change 에만 (선언은 ${type})`);
        shapes.push({ name, fields: { type, code: { repo: task.target.repo, branch: task.target.task_branch, base_sha: m[1]!, head_sha: m[2]! } } });
      } else if ((m = REPO_SOURCE.exec(source))) {
        shapes.push({ name, fields: { type, stored_in: 'repo', code: { repo: task.target.repo, branch: task.target.task_branch, base_sha: m[1]!, head_sha: m[2]! }, paths: m[3]!.split(',') } });
      } else if ((m = BLOB_SOURCE.exec(source))) {
        if (m[1] !== 'work-notes' || notesKey === undefined) reasons.push(`${label}: blob:${m[1]} 은 이 commit 의 blob 이 아니다 (blob:work-notes 는 작업 노트를 줄 때만)`);
        else if (type === 'code_change') reasons.push(`${label}: code_change 는 blob 에 둘 수 없다`);
        else shapes.push({ name, fields: { type, stored_in: 'store', content_key: notesKey } });
      } else {
        reasons.push(`${label}: ${JSON.stringify(source)} 는 code:<sha>..<sha>, repo:<sha>..<sha>:<path>, blob:<label> 가 아니다 (SHA 는 40자·64자 16진 소문자)`);
      }
    }
    rejectIf(reasons);

    return (c) => {
      artifacts = shapes.map(({ name, fields }) => {
        const version = c.nextArtifactVersion(stepId, name);
        return {
          ref: artifactRef(taskId, stepId, name, version),
          task_id: taskId,
          step_id: stepId,
          name,
          version,
          type: fields.type!,
          author: 'worker',
          run_id: runId,
          ...fields,
          ...(notesKey !== undefined ? { work_notes_key: notesKey } : {}),
          created_at: at,
        } as ArtifactVersion;
      });
      const done: Run = { ...run, status: 'completed', ...(input.outputAttempts !== undefined ? { output_attempts: input.outputAttempts } : {}), ended_at: at, packet_gaps: output.packet_gaps };
      const blobs: BlobWrite[] = [{ owner, name: 'output.json', content: input.workerOutput }];
      if (input.workNotes !== undefined) blobs.push({ owner, name: 'work-notes', content: input.workNotes });
      const events: NewEvent[] = [
        { type: 'run.completed', actor: 'role:worker', step_id: stepId, run_id: runId, ...(input.note !== undefined ? { data: { note: input.note } } : {}), ...tail(ctx, at) },
        ...artifacts.map((a): NewEvent => ({ type: 'artifact.version_added', actor: 'role:worker', step_id: stepId, run_id: runId, ref: a.ref, ...tail(ctx, at) })),
        ...statusChangedEvents(stepId, [step.status, next], tail(ctx, at)),
      ];
      return {
        writes: [{ kind: 'run', value: done }, ...artifacts.map((a): EntityWrite => ({ kind: 'artifact', value: a })), { kind: 'step', value: { ...step, status: next } }],
        blobs,
        events: events as [NewEvent, ...NewEvent[]],
      };
    };
  });
  return { artifacts, result };
}

/** 고칠 Run: 있고, 그 role 이고, 아직 submitted 다(completed·failed 인 Run 에 다시 쓰지 않는다 — commands.md 6.3). */
export async function submittedRun(ctx: CommandContext, taskId: string, runId: string, role?: Run['role'], stepId?: string): Promise<Run> {
  const run = isCanonicalId('run', runId) ? await ctx.store.get('run', { taskId, id: runId }) : undefined;
  if (run === undefined) throw new RejectedInputError([`runId: ${taskId} 에 ${runId} 가 없다`]);
  const reasons: string[] = [];
  if (role !== undefined && run.role !== role) reasons.push(`runId: ${runId} 는 ${run.role} 의 Run 이다 (${role} 여야 한다)`);
  if (stepId !== undefined && run.step_id !== stepId) reasons.push(`runId: ${runId} 는 ${run.step_id ?? 'Task 수준'} 의 Run 이다 (${stepId} 여야 한다)`);
  if (run.status !== 'submitted') reasons.push(`runId: ${runId} 는 이미 ${run.status} 다 — 끝난 Run 에 다시 쓰지 않는다`);
  rejectIf(reasons);
  return run;
}

// ---------------------------------------------------------------- failRun

export interface FailRunInput {
  failureKind?: Run['failure_kind'];
  taskId: string;
  runId: string;
  reason: string;
  note?: string;
  /** 경위 문서. blob R-NNN.failed 로 남는다. */
  failedNotes?: string;
  /** Workspace 에 남은 commit 되지 않은 변경. blob R-NNN.partial.diff 로 남는다. */
  partialDiff?: string;
}

/**
 * 끊긴 실행을 기록한다: Run(failed, ended_at = 기록한 시각), blob R-NNN.failed·R-NNN.partial.diff(주어지면), run.failed(data.reason, data.note) — 한 commit.
 * Step 의 status 는 바꾸지 않는다(다시 제출하면 running·revising 그대로 — 7절).
 */
export async function failRun(ctx: CommandContext, input: FailRunInput): Promise<{ run: Run; result: CommitResult }> {
  checkKeys(input, ['taskId', 'runId', 'reason', 'note', 'failedNotes', 'partialDiff', 'failureKind']);
  const { taskId, runId } = input;
  if (input.reason.trim() === '') throw new RejectedInputError(['reason: 비어 있다']);
  const at = recordedAt(ctx.clock);
  let run!: Run;
  const result = await commitAfterReading(ctx, taskId, async () => {
    await openTask(ctx, taskId);
    const before = await submittedRun(ctx, taskId, runId);
    return () => {
      run = { ...before, status: 'failed', ended_at: at, ...(input.failureKind ? { failure_kind: input.failureKind } : {}) };
      const owner: BlobOwner = { taskId, ...(before.step_id !== undefined ? { stepId: before.step_id } : {}), runId };
      const blobs: BlobWrite[] = [];
      if (input.failedNotes !== undefined) blobs.push({ owner, name: 'failed', content: input.failedNotes });
      if (input.partialDiff !== undefined) blobs.push({ owner, name: 'partial.diff', content: input.partialDiff });
      const event: NewEvent = {
        type: 'run.failed',
        actor: 'system',
        ...(before.step_id !== undefined ? { step_id: before.step_id } : {}),
        run_id: runId,
        data: withNote({ reason: input.reason }, input.note),
        ...tail(ctx, at),
      };
      return { writes: [{ kind: 'run', value: run }], blobs, events: [event] };
    };
  });
  return { run, result };
}
