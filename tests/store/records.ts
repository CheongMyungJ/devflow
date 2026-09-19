// 0단계의 한 Step 치 기록을 만드는 도우미. 모양은 repo devflow-data 의 실제 기록(과 tests/fixtures/validate-data)을 따른다.
// 생성 타입으로 타입을 붙이므로 스키마의 모양이 바뀌면 typecheck 가 알린다.
import type { ArtifactVersion, Decision, Event, Feedback, GateResult, Run, Step, StepDefinition } from '../../src/types/generated/index.js';
import type { NewEvent } from '../../src/store/types.js';

export const AT = '2026-01-01T00:00:00Z';

export const stepDefinition = (goal = '예시 문서를 쓴다.'): StepDefinition => ({
  skill: null,
  goal,
  scope: { include: ['docs/example.md'] },
  inputs: ['task.brief'],
  outputs: [
    { name: 'plan', type: 'document' },
    { name: 'change', type: 'code_change' },
  ],
  done_when: ['예시 문서가 있다'],
  verify: { semantic: ['문서가 목표를 말하는가'] },
  approval: 'required',
});

export const decision = (taskId: string, id: string, plannerRunId?: string): Decision => ({
  id,
  task_id: taskId,
  after_step: null,
  action: 'next_step',
  rationale: '예시 Decision.',
  next_step: { step: stepDefinition() },
  packet_gaps: [],
  ...(plannerRunId ? { planner_run_id: plannerRunId } : {}),
  created_at: AT,
});

export const step = (taskId: string, stepId: string, status: Step['status'] = 'defined', createdFrom?: string): Step => ({
  id: stepId,
  task_id: taskId,
  ...stepDefinition(),
  status,
  ...(createdFrom ? { created_from: createdFrom } : {}),
});

export const run = (taskId: string, id: string, options: { stepId?: string; role?: Run['role']; status?: Run['status'] } = {}): Run => ({
  id,
  task_id: taskId,
  ...(options.stepId ? { step_id: options.stepId } : {}),
  role: options.role ?? 'worker',
  access: 'write',
  backend: 'fake',
  session_path: 'new',
  performer: 'isolated_session',
  status: options.status ?? 'completed',
  submitted_at: AT,
});

export const feedback = (taskId: string, id: string, options: { stepId?: string; kind?: Feedback['kind']; artifactRef?: string } = {}): Feedback => ({
  id,
  task_id: taskId,
  ...(options.stepId ? { step_id: options.stepId } : {}),
  kind: options.kind ?? 'requirement',
  channel: 'review',
  ...(options.artifactRef ? { target: { artifact_ref: options.artifactRef } } : {}),
  text: '예시',
  author: 'tester',
  created_at: AT,
});

export const gate = (taskId: string, stepId: string, id: string, artifactRefs: [string, ...string[]], logKey?: string): GateResult => ({
  id,
  task_id: taskId,
  step_id: stepId,
  artifact_refs: artifactRefs,
  verdict: 'pass',
  checks: [{ kind: 'deterministic', name: 'test', result: 'pass', ...(logKey ? { log_key: logKey } : {}) }],
  comments: [],
  created_at: AT,
});

/** 내용이 Store 의 blob 에 있는 문서 (stored_in: store). */
export const storedDocument = (taskId: string, stepId: string, name: string, version: number, runId: string, contentKey: string): ArtifactVersion => ({
  ref: `artifact://${taskId}/${stepId}/${name}@v${version}`,
  task_id: taskId,
  step_id: stepId,
  name,
  version,
  type: 'document',
  author: 'worker',
  run_id: runId,
  stored_in: 'store',
  content_key: contentKey,
  created_at: AT,
});

/** 대상 repo 의 코드 변경 (stored_in: repo). */
export const codeChange = (taskId: string, stepId: string, name: string, version: number, runId: string, workNotesKey?: string): ArtifactVersion => ({
  ref: `artifact://${taskId}/${stepId}/${name}@v${version}`,
  task_id: taskId,
  step_id: stepId,
  name,
  version,
  type: 'code_change',
  author: 'worker',
  run_id: runId,
  stored_in: 'repo',
  code: { repo: 'example-project', branch: `task/${taskId}`, base_sha: '0'.repeat(40), head_sha: '1'.repeat(40) },
  paths: ['docs/example.md'],
  ...(workNotesKey ? { work_notes_key: workNotesKey } : {}),
  created_at: AT,
});

export const event = (type: Event['type'], extra: Partial<NewEvent> = {}): NewEvent => ({ type, actor: 'system', at: AT, ...extra });
