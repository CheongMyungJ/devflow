// Worker·Reviewer 쪽 command — submitRun, completeRun, failRun, recordGate (T-0006 step-004 ②, docs/design/commands.md 6.1~6.3, 7절).
// 거부는 모두 "아무것도 쓰기 전" 이다 — 거부 뒤 데이터 디렉터리의 contentSnapshot 이 같다.
import { describe, expect, it } from 'vitest';
import { completeRun, failRun, recordGate, submitRun } from '../../src/commands/index.js';
import { TaskNotFoundError } from '../../src/store/errors.js';
import { createSample, newStore, tempDataDir } from '../store/helpers.js';
import { run as runRecord } from '../store/records.js';
import {
  artifactsOf,
  ctxOf,
  expectRejected,
  NOW_SECONDS,
  reviewerOutput,
  SHA_A,
  SHA_B,
  SHA_C,
  setupRound,
  submitReviewer,
  workerOutput,
  workerRound,
} from './round-helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const worker = { stepId: 'step-001', role: 'worker', access: 'write', backend: 'fake', sessionPath: 'new' } as const;
const reviewer = { stepId: 'step-001', role: 'reviewer', access: 'read', backend: 'fake', sessionPath: 'new' } as const;

describe('submitRun', () => {
  it('worker 를 defined 에서: Run(submitted), blob packet, run.submitted, step.yaml running 과 step.status_changed 를 한 commit 에', async () => {
    const { store, taskId, sys } = await setupRound('defined');
    const { run, result } = await submitRun(sys, { taskId, ...worker, model: 'm', packet: '# 패킷\n', note: '메모', expectId: 'R-001' });
    expect(run).toEqual({ id: 'R-001', task_id: taskId, step_id: 'step-001', role: 'worker', access: 'write', backend: 'fake', model: 'm', session_path: 'new', status: 'submitted', system_sha: SHA_A, submitted_at: NOW_SECONDS });
    expect(result.events.map((e) => [e.type, e.actor, e.run_id, e.data, e.commit_id === result.commitId, e.at])).toEqual([
      ['run.submitted', 'system', 'R-001', { role: 'worker', backend: 'fake', note: '메모' }, true, NOW_SECONDS],
      ['step.status_changed', 'system', undefined, { from: 'defined', to: 'running' }, true, NOW_SECONDS],
    ]);
    expect(result.commitId).toMatch(UUID);
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('running');
    expect(new TextDecoder().decode(await store.getBlob(`blob:${taskId}/step-001/R-001.packet`))).toBe('# 패킷\n');
  });

  it('worker 를 running(앞 Run 이 failed)·revising 에서, reviewer 를 checking 에서 — status 그대로, step.status_changed 없음', async () => {
    for (const [status, spec] of [['running', worker], ['revising', worker], ['checking', reviewer]] as const) {
      const { store, taskId, sys } = await setupRound(status);
      const { result } = await submitRun(sys, { taskId, ...spec });
      expect(result.events.map((e) => e.type)).toEqual(['run.submitted']);
      expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe(status);
    }
  });

  it('planner 는 Task 수준, resumed 면 resumedFrom 과 data 의 session_path·resumed_from', async () => {
    const { store, taskId, sys } = await setupRound();
    await submitRun(sys, { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'new' });
    await failRun(sys, { taskId, runId: 'R-001', reason: '끊김' });
    const { run, result } = await submitRun(sys, { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'resumed', resumedFrom: 'R-001' });
    expect(run).toMatchObject({ id: 'R-002', session_path: 'resumed', resumed_from: 'R-001' });
    expect(run.step_id).toBeUndefined();
    expect(result.events[0]!.data).toEqual({ role: 'planner', backend: 'fake', session_path: 'resumed', resumed_from: 'R-001' });
    expect(await store.get('run', { taskId, id: 'R-002' })).toEqual(run);
  });

  it.each([
    ['role intake (G-001 B — 닫는 command 가 없다)', 'defined', { role: 'intake', access: 'read', backend: 'fake', sessionPath: 'new' }, /intake Run 은 받지 않는다/],
    ['worker 인데 Step 이 없다', 'defined', { ...worker, stepId: undefined }, /Step 에 속한다/],
    ['planner 인데 Step 을 준다', 'defined', { ...worker, role: 'planner' }, /Task 수준/],
    ['없는 Step', 'defined', { ...worker, stepId: 'step-009' }, /step-009 가 없다/],
    ['closed 인 Step 에 worker (전이표)', 'closed', worker, /closed 다 — submitRun\(worker\) 는 defined·running·revising 에서만/],
    ['proposed 인 Step 에 worker (전이표)', 'proposed', worker, /proposed 다/],
    ['running 인 Step 에 reviewer (전이표)', 'running', reviewer, /submitRun\(reviewer\) 는 checking 에서만/],
    ['expectId 가 발급될 id 와 다르다', 'defined', { ...worker, expectId: 'R-002' }, /발급될 Run id 는 R-001 다/],
    ['expectId 가 정규형이 아니다', 'defined', { ...worker, expectId: 'R1' }, /정규형이 아니다/],
    ['resumed 인데 resumedFrom 이 없다', 'defined', { ...worker, sessionPath: 'resumed' }, /이어간 Run 을 준다/],
    ['없는 Run 에서 이어간다', 'defined', { ...worker, sessionPath: 'resumed', resumedFrom: 'R-007' }, /R-007 가 없다/],
    ['입력의 시각(도구가 채우는 필드)', 'defined', { ...worker, submittedAt: '2026-01-01T00:00:00Z' }, /submittedAt: 도구가 채우는 필드다/],
    ['입력의 id', 'defined', { ...worker, id: 'R-005' }, /id: 도구가 채우는 필드다/],
    ['입력의 status', 'defined', { ...worker, status: 'completed' }, /status: 도구가 채우는 필드다/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, status, spec, reason) => {
    const { dataDir, taskId, sys } = await setupRound(status);
    expect(await expectRejected(dataDir, () => submitRun(sys, { taskId, ...(spec as object) } as never))).toMatch(reason);
  });

  it('같은 Step 에 아직 submitted 인 같은 role 의 Run 이 있으면 거부', async () => {
    const { dataDir, taskId, sys } = await setupRound('defined');
    await submitRun(sys, { taskId, ...worker });
    expect(await expectRejected(dataDir, () => submitRun(sys, { taskId, ...worker }))).toMatch(/아직 submitted 인 worker Run\(R-001\)/);
  });

  it('없는 Task 는 TaskNotFoundError, 끝난 Task 는 거부 — 아무것도 쓰지 않는다', async () => {
    const { dataDir, sys } = await setupRound();
    await expectRejected(dataDir, () => submitRun(sys, { taskId: 'T-0009', ...worker }), TaskNotFoundError);
    await expectRejected(dataDir, () => submitRun(sys, { taskId: '../T-0001', ...worker }), TaskNotFoundError);
    const done = tempDataDir();
    const store = newStore(done);
    const task = await createSample(store, { status: 'done' });
    expect(await expectRejected(done, () => submitRun(ctxOf(store), { taskId: task.id, role: 'planner', access: 'read', backend: 'f', sessionPath: 'new' }))).toMatch(/done 다/);
  });
});

describe('completeRun', () => {
  it('running → checking: Run(completed, packet_gaps ← worker-output), blob 둘, Artifact meta, run.completed, artifact.version_added×2, step.status_changed', async () => {
    const { store, taskId, sys } = await setupRound('defined');
    await submitRun(sys, { taskId, ...worker });
    const { artifacts, result } = await completeRun(sys, { taskId, runId: 'R-001', workerOutput: workerOutput(['부족 하나']), workNotes: '# 노트\n', artifacts: artifactsOf(), outputAttempts: 2, note: 'n' });
    expect(await store.get('run', { taskId, id: 'R-001' })).toMatchObject({ status: 'completed', ended_at: NOW_SECONDS, packet_gaps: ['부족 하나'], output_attempts: 2 });
    expect(artifacts).toEqual([
      { ref: `artifact://${taskId}/step-001/plan@v1`, task_id: taskId, step_id: 'step-001', name: 'plan', version: 1, type: 'document', author: 'worker', run_id: 'R-001', stored_in: 'store', content_key: `blob:${taskId}/step-001/R-001.work-notes`, work_notes_key: `blob:${taskId}/step-001/R-001.work-notes`, created_at: NOW_SECONDS },
      { ref: `artifact://${taskId}/step-001/change@v1`, task_id: taskId, step_id: 'step-001', name: 'change', version: 1, type: 'code_change', author: 'worker', run_id: 'R-001', code: { repo: 'r', branch: `task/${taskId}`, base_sha: SHA_A, head_sha: SHA_B }, work_notes_key: `blob:${taskId}/step-001/R-001.work-notes`, created_at: NOW_SECONDS },
    ]);
    expect(result.events.map((e) => [e.type, e.actor, e.ref, e.data])).toEqual([
      ['run.completed', 'role:worker', undefined, { note: 'n' }],
      ['artifact.version_added', 'role:worker', `artifact://${taskId}/step-001/plan@v1`, undefined],
      ['artifact.version_added', 'role:worker', `artifact://${taskId}/step-001/change@v1`, undefined],
      ['step.status_changed', 'system', undefined, { from: 'running', to: 'checking' }],
    ]);
    expect(new TextDecoder().decode(await store.getBlob(`blob:${taskId}/step-001/R-001.output.json`))).toBe(workerOutput(['부족 하나']));
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('checking');
  });

  it('repo: 출처는 stored_in repo 와 paths', async () => {
    const { taskId, sys } = await setupRound('defined');
    await submitRun(sys, { taskId, ...worker });
    const { artifacts } = await completeRun(sys, { taskId, runId: 'R-001', workerOutput: workerOutput(), artifacts: [{ name: 'plan', source: `repo:${SHA_A}..${SHA_B}:docs/a.md,docs/b.md` }, { name: 'change', source: `code:${SHA_A}..${SHA_B}` }] });
    expect(artifacts[0]).toMatchObject({ stored_in: 'repo', paths: ['docs/a.md', 'docs/b.md'], code: { base_sha: SHA_A, head_sha: SHA_B } });
  });

  const base = { runId: 'R-001', workerOutput: workerOutput(), workNotes: '# n', artifacts: artifactsOf() };
  it.each([
    ['worker-output 이 JSON 이 아니다', { workerOutput: 'summary: x' }, /workerOutput: JSON 이 아니다/],
    ['worker-output 에 packet_gaps 가 없다 (F-001 3-가)', { workerOutput: JSON.stringify({ summary: 's' }) }, /must have required property 'packet_gaps'.*worker-output/],
    ['선언되지 않은 산출물 이름', { artifacts: [...artifactsOf(), { name: 'extra', source: 'blob:work-notes' }] }, /extra 는 step-001 의 outputs 에 없다/],
    ['선언된 이름이 빠졌다', { artifacts: artifactsOf().slice(0, 1) }, /outputs 의 change 가 빠졌다/],
    ['같은 이름이 두 번', { artifacts: [...artifactsOf(), artifactsOf()[0]!] }, /plan 가 두 번 있다/],
    ['SHA 가 40자 16진 소문자가 아니다', { artifacts: [artifactsOf()[0]!, { name: 'change', source: `code:${SHA_A}..ABC` }] }, /code:<sha>\.\.<sha>/],
    ['로컬 경로 모양의 출처', { artifacts: [{ name: 'plan', source: 'C:\\notes.md' }, artifactsOf()[1]!] }, /는 code:<sha>/],
    ['이 commit 에 없는 blob', { artifacts: [{ name: 'plan', source: 'blob:other' }, artifactsOf()[1]!] }, /blob:other 은 이 commit 의 blob 이 아니다/],
    ['작업 노트 없이 blob:work-notes', { workNotes: undefined }, /blob:work-notes 는 작업 노트를 줄 때만/],
    ['code: 를 문서에', { artifacts: [{ name: 'plan', source: `code:${SHA_A}..${SHA_B}` }, artifactsOf()[1]!] }, /code: 는 code_change 에만/],
    ['outputAttempts 가 0', { outputAttempts: 0 }, /outputAttempts/],
    ['입력의 시각', { endedAt: '2026-01-01T00:00:00Z' }, /endedAt: 도구가 채우는 필드다/],
    ['입력의 packet_gaps(도구가 worker-output 에서 옮긴다)', { packetGaps: [] }, /packetGaps: 모르는 입력이다/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, patch, reason) => {
    const { dataDir, taskId, sys } = await setupRound('defined');
    await submitRun(sys, { taskId, ...worker });
    expect(await expectRejected(dataDir, () => completeRun(sys, { taskId, ...base, ...(patch as object) } as never))).toMatch(reason);
  });

  it('거부 — Run 이 reviewer 이다 / 이미 completed 다 / 없다', async () => {
    const { dataDir, taskId, sys } = await setupRound('defined');
    await workerRound(sys, taskId);
    await submitReviewer(sys, taskId);
    expect(await expectRejected(dataDir, () => completeRun(sys, { taskId, ...base, runId: 'R-002' }))).toMatch(/R-002 는 reviewer 의 Run 이다/);
    expect(await expectRejected(dataDir, () => completeRun(sys, { taskId, ...base, runId: 'R-001' }))).toMatch(/R-001 는 이미 completed 다/);
    expect(await expectRejected(dataDir, () => completeRun(sys, { taskId, ...base, runId: 'R-009' }))).toMatch(/R-009 가 없다/);
  });

  it('거부 — 표에 없는 전이: in_review 에서 completeRun', async () => {
    const { dataDir, store, taskId, sys } = await setupRound('in_review');
    await store.commit(taskId, { writes: [{ kind: 'run', value: runRecord(taskId, 'R-001', { stepId: 'step-001', status: 'submitted' }) }], events: [{ type: 'run.submitted', actor: 'system', run_id: 'R-001', at: NOW_SECONDS }] });
    expect(await expectRejected(dataDir, () => completeRun(sys, { taskId, ...base }))).toMatch(/in_review 다 — completeRun 는 running·revising 에서만/);
  });
});

describe('failRun', () => {
  it('Run failed, blob failed·partial.diff, run.failed(data.reason, note) — Step 의 status 는 그대로', async () => {
    const { store, taskId, sys } = await setupRound('defined');
    await submitRun(sys, { taskId, ...worker });
    const { run, result } = await failRun(sys, { taskId, runId: 'R-001', reason: '한도', note: 'n', failedNotes: '# 경위', partialDiff: 'diff --git a b\n' });
    expect(run).toMatchObject({ status: 'failed', ended_at: NOW_SECONDS });
    expect(result.events).toEqual([expect.objectContaining({ type: 'run.failed', actor: 'system', step_id: 'step-001', run_id: 'R-001', data: { reason: '한도', note: 'n' }, at: NOW_SECONDS })]);
    expect(new TextDecoder().decode(await store.getBlob(`blob:${taskId}/step-001/R-001.partial.diff`))).toBe('diff --git a b\n');
    expect(await store.getBlob(`blob:${taskId}/step-001/R-001.failed`)).toBeDefined();
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('running');
  });

  it('거부 — 이미 failed·completed 인 Run, 없는 Run, 빈 reason', async () => {
    const { dataDir, taskId, sys } = await setupRound('defined');
    await workerRound(sys, taskId);
    await submitReviewer(sys, taskId);
    await failRun(sys, { taskId, runId: 'R-002', reason: 'x' });
    expect(await expectRejected(dataDir, () => failRun(sys, { taskId, runId: 'R-002', reason: 'x' }))).toMatch(/이미 failed 다/);
    expect(await expectRejected(dataDir, () => failRun(sys, { taskId, runId: 'R-001', reason: 'x' }))).toMatch(/이미 completed 다/);
    expect(await expectRejected(dataDir, () => failRun(sys, { taskId, runId: 'R-003', reason: 'x' }))).toMatch(/R-003 가 없다/);
    expect(await expectRejected(dataDir, () => failRun(sys, { taskId, runId: 'R-003', reason: ' ' }))).toMatch(/reason: 비어 있다/);
  });
});

describe('recordGate', () => {
  async function checking() {
    const s = await setupRound('defined');
    const { refs } = await workerRound(s.sys, s.taskId);
    const runId = await submitReviewer(s.sys, s.taskId);
    return { ...s, refs, runId };
  }

  it('pass → in_review: Gate, Reviewer Run(completed, packet_gaps), blob output·annotations·deterministic, run.completed, gate.completed, step.status_changed', async () => {
    const { store, taskId, sys, refs, runId } = await checking();
    const annotations = [{ source: 'system', text: '시스템의 실측' }];
    const { gate, result } = await recordGate(sys, { taskId, stepId: 'step-001', gateId: 'G-001', reviewerRunId: runId, artifactRefs: refs, output: reviewerOutput('pass', { packet_gaps: ['gap'] }), annotations, deterministic: '# det\n', outputAttempts: 1 });
    expect(gate).toMatchObject({ id: 'G-001', task_id: taskId, step_id: 'step-001', artifact_refs: refs, verdict: 'pass', annotations, reviewer_run_id: runId, created_at: NOW_SECONDS });
    expect(await store.get('run', { taskId, id: runId })).toMatchObject({ status: 'completed', packet_gaps: ['gap'], output_attempts: 1, ended_at: NOW_SECONDS });
    expect(result.events.map((e) => [e.type, e.actor, e.ref, e.data])).toEqual([
      ['run.completed', 'role:reviewer', undefined, undefined],
      ['gate.completed', 'role:reviewer', 'G-001', { verdict: 'pass', class_a: 0, class_b: 0, class_c: 1 }],
      ['step.status_changed', 'system', undefined, { from: 'checking', to: 'in_review' }],
    ]);
    for (const key of [`blob:${taskId}/step-001/${runId}.output.json`, `blob:${taskId}/step-001/G-001.annotations.json`, `blob:${taskId}/step-001/G-001.deterministic`]) expect(await store.getBlob(key), key).toBeDefined();
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('in_review');
  });

  it('fail → revising, gate id 를 생략하면 도구가 발급', async () => {
    const { store, taskId, sys, refs, runId } = await checking();
    const { gate } = await recordGate(sys, { taskId, stepId: 'step-001', reviewerRunId: runId, artifactRefs: refs, output: reviewerOutput('fail') });
    expect(gate.id).toBe('G-001');
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('revising');
  });

  const good = (refs: string[], runId: string) => ({ stepId: 'step-001', gateId: 'G-001', reviewerRunId: runId, artifactRefs: refs, output: reviewerOutput() });
  it.each([
    ['gate id G1 (정규형 아님)', () => ({ gateId: 'G1' }), /G-NNN 의 정규형이 아니다/],
    ['gate id g-001', () => ({ gateId: 'g-001' }), /정규형이 아니다/],
    ['gate id G-0012', () => ({ gateId: 'G-0012' }), /정규형이 아니다/],
    ['파일 이름이 될 수 없는 gate id', () => ({ gateId: 'G-001/../x' }), /정규형이 아니다/],
    ['다음에 발급될 id 와 다른 gate id', () => ({ gateId: 'G-002' }), /다음에 발급될 Gate id 는 G-001 다/],
    ['로컬 경로가 섞인 artifact 참조 (a,,C:\\x)', (refs: string[]) => ({ artifactRefs: [refs[0], '', 'C:\\x'] }), /"" 는 artifact:\/\/.*\n.*"C:\\\\x" 는 artifact:\/\//],
    ['다른 Step 의 참조', (refs: string[]) => ({ artifactRefs: [refs[0]!.replace('step-001', 'step-002')] }), /step-001 의 것이 아니다/],
    ['다른 Task 의 참조', (refs: string[]) => ({ artifactRefs: [refs[0]!.replace(/T-\d+/, 'T-0999')] }), /의 것이 아니다/],
    ['없는 버전', (refs: string[]) => ({ artifactRefs: [refs[0]!.replace('@v1', '@v2')] }), /@v2 가 없다/],
    ['같은 참조가 두 번', (refs: string[]) => ({ artifactRefs: [refs[0], refs[0]] }), /두 번 있다/],
    ['class A 인데 pass (옛 검증 3)', () => ({ output: reviewerOutput('pass', { comments: [{ severity: 'defect', class: 'A', text: 'x' }] }) }), /verdict is pass but there are class A findings/],
    ['출력이 스키마에 맞지 않다 — 문장 comments (옛 검증 2)', () => ({ output: reviewerOutput('pass', { comments: ['[note / C] 문장'] }) }), /output\/comments\/0: must be object/],
    ['출력에 packet_gaps 가 없다 (옛 검증 2)', () => ({ output: JSON.stringify({ ...JSON.parse(reviewerOutput()), packet_gaps: undefined }) }), /required property 'packet_gaps'/],
    ['출력이 JSON 이 아니다', () => ({ output: 'verdict: pass' }), /JSON 이 아니다/],
    ['빈 annotations', () => ({ annotations: [] }), /annotations: 하나 이상/],
    ['annotations 가 Gate 스키마에 맞지 않다 (옛 검증 4)', () => ({ annotations: [{ source: 'reviewer', text: 'x' }] }), /annotations\/0\/source.*gate-result/],
    ['Run 이 worker 의 것이다 (옛 검증 1)', () => ({ reviewerRunId: 'R-001' }), /R-001 는 worker 의 Run 이다/],
    ['입력의 시각', () => ({ createdAt: '2026-01-01T00:00:00Z' }), /createdAt: 도구가 채우는 필드다/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, patch, reason) => {
    const { dataDir, taskId, sys, refs, runId } = await checking();
    expect(await expectRejected(dataDir, () => recordGate(sys, { taskId, ...good(refs, runId), ...(patch as (r: string[]) => object)(refs) } as never))).toMatch(reason);
  });

  it('거부 — 이미 있는 Gate 를 같은 id 로 다시 / 이미 completed 인 Reviewer Run / checking 이 아닌 Step (전이표)', async () => {
    const { dataDir, taskId, sys, refs, runId } = await checking();
    await recordGate(sys, { taskId, ...good(refs, runId) });
    const again = await submitReviewer(sys, taskId).catch((e: unknown) => e); // in_review 에서 reviewer 제출은 전이표 밖
    expect(String(again)).toMatch(/submitRun\(reviewer\) 는 checking 에서만/);
    expect(await expectRejected(dataDir, () => recordGate(sys, { taskId, ...good(refs, runId) }))).toMatch(/이미 completed 다/);
    expect(await expectRejected(dataDir, () => recordGate(sys, { taskId, ...good(refs, runId), gateId: 'G-001' }))).toMatch(/이미 completed 다/);
  });

  it('거부 — 이미 있는 Gate id(G-001)를 다음 Gate 에 쓰려 하면 발급될 id(G-002)와 달라 거부', async () => {
    const { dataDir, taskId, sys, refs, runId } = await checking();
    await recordGate(sys, { taskId, ...good(refs, runId), output: reviewerOutput('fail') });
    const { refs: refs2 } = await workerRound(sys, taskId, SHA_C);
    const runId2 = await submitReviewer(sys, taskId);
    expect(await expectRejected(dataDir, () => recordGate(sys, { taskId, ...good(refs2, runId2), gateId: 'G-001' }))).toMatch(/발급될 Gate id 는 G-002 다/);
    // 가장 새 버전이 아닌 참조(재작업 뒤의 v1)
    expect(await expectRejected(dataDir, () => recordGate(sys, { taskId, ...good(refs, runId2), gateId: 'G-002' }))).toMatch(/plan@v1 는 plan 의 가장 새 버전이 아니다 \(가장 새 것은 v2\)/);
    const { gate } = await recordGate(sys, { taskId, ...good(refs2, runId2), gateId: 'G-002' });
    expect(gate.artifact_refs).toEqual([`artifact://${taskId}/step-001/plan@v2`, `artifact://${taskId}/step-001/change@v2`]);
  });

  it('거부 — 표에 없는 전이: running 인 Step 에 Gate', async () => {
    const { dataDir, store, taskId, sys } = await setupRound('running');
    await store.commit(taskId, { writes: [{ kind: 'run', value: runRecord(taskId, 'R-001', { stepId: 'step-001', role: 'reviewer', status: 'submitted' }) }], events: [{ type: 'run.submitted', actor: 'system', run_id: 'R-001', at: NOW_SECONDS }] });
    expect(await expectRejected(dataDir, () => recordGate(sys, { taskId, stepId: 'step-001', reviewerRunId: 'R-001', artifactRefs: [`artifact://${taskId}/step-001/plan@v1`], output: reviewerOutput() }))).toMatch(/running 다 — recordGate\(pass\) 는 checking 에서만/);
  });
});
