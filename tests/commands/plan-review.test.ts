// Planner·사람 쪽 command — recordDecision, defineStep, requestRevision, approveStep, addFeedback (T-0006 step-004 ③, commands.md 6.1~6.3, 7절).
// 거부는 모두 "아무것도 쓰기 전" 이다 — 거부 뒤 데이터 디렉터리의 contentSnapshot 이 같다.
import { describe, expect, it } from 'vitest';
import { addFeedback, approveStep, defineStep, recordDecision, recordGate, requestRevision, submitRun } from '../../src/commands/index.js';
import type { Decision } from '../../src/types/generated/index.js';
import { createSample, newStore, tempDataDir } from '../store/helpers.js';
import { stepDefinition } from '../store/records.js';
import { ctxOf, expectRejected, NOW_SECONDS, reviewerOutput, SHA_C, setupRound, submitReviewer, workerRound } from './round-helpers.js';

/** Step 이 없는 Task 와 submitted 인 Planner Run R-001. */
async function planning() {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  const taskId = (await createSample(store)).id;
  const sys = ctxOf(store);
  await submitRun(sys, { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'new' });
  return { dataDir, store, taskId, sys, human: ctxOf(store, 'human:tester') };
}

const proposal = (overrides: Record<string, unknown> = {}) => ({
  id: 'D-999',
  task_id: 'T-9999',
  after_step: null,
  action: 'next_step',
  rationale: '예시',
  next_step: { step: stepDefinition() },
  packet_gaps: ['Planner 의 부족'],
  created_at: '2000-01-01T00:00:00Z',
  ...overrides,
});
const TEXT = 'id: D-999\n# Planner 가 쓴 원문\n';

describe('recordDecision', () => {
  it('next_step: 원문 blob, Decision(도구가 id·task_id·planner_run_id·created_at 을 채움), Run 완료와 packet_gaps, step.yaml(proposed, created_from), step.proposed — step.status_changed 는 없다', async () => {
    const { store, taskId, sys } = await planning();
    const { decision, step, result } = await recordDecision(sys, { taskId, runId: 'R-001', output: proposal(), outputText: TEXT, outputAttempts: 1 });
    expect(decision).toMatchObject({ id: 'D-001', task_id: taskId, planner_run_id: 'R-001', created_at: NOW_SECONDS, action: 'next_step' });
    expect(step).toEqual({ id: 'step-001', task_id: taskId, ...stepDefinition(), status: 'proposed', created_from: 'D-001' });
    expect(await store.get('run', { taskId, id: 'R-001' })).toMatchObject({ status: 'completed', packet_gaps: ['Planner 의 부족'], output_attempts: 1, ended_at: NOW_SECONDS });
    expect(new TextDecoder().decode(await store.getBlob(`blob:${taskId}/R-001.output.yaml`))).toBe(TEXT);
    expect(result.events.map((e) => [e.type, e.actor, e.step_id, e.ref, e.data])).toEqual([
      ['run.completed', 'role:planner', undefined, undefined, undefined],
      ['decision.made', 'role:planner', undefined, 'D-001', { action: 'next_step' }],
      ['step.proposed', 'system', 'step-001', 'D-001', undefined],
    ]);
  });

  it('ask_human 은 Decision 과 Run 완료만 — Step 을 만들지 않는다', async () => {
    const { store, taskId, sys } = await planning();
    const { step } = await recordDecision(sys, { taskId, runId: 'R-001', output: proposal({ action: 'ask_human', next_step: undefined, question: { text: '?' } }), outputText: TEXT });
    expect(step).toBeUndefined();
    expect((await store.list('step', { taskId })).items).toEqual([]);
  });

  it.each([
    ['Decision 스키마에 맞지 않다(rationale 없음)', { output: proposal({ rationale: undefined }) }, /required property 'rationale'/],
    ['제안된 Step 정의가 스키마에 맞지 않다', { output: proposal({ next_step: { step: { ...stepDefinition(), outputs: [] } } }) }, /next_step|outputs/],
    ['출력이 객체가 아니다', { output: ['x'] }, /Decision 모양의 객체/],
    ['outputAttempts 0', { outputAttempts: 0 }, /outputAttempts/],
    ['입력의 시각', { createdAt: 'x' }, /createdAt: 도구가 채우는 필드다/],
    ['Planner 가 아닌 Run', { runId: 'R-009' }, /R-009 가 없다/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, patch, reason) => {
    const { dataDir, taskId, sys } = await planning();
    expect(await expectRejected(dataDir, () => recordDecision(sys, { taskId, runId: 'R-001', output: proposal(), outputText: TEXT, ...(patch as object) } as never))).toMatch(reason);
  });

  it('거부 — 닫히지 않은 Step 이 있을 때의 next_step, 이미 completed 인 Run', async () => {
    const { dataDir, taskId, sys } = await setupRound('closed');
    await submitRun(sys, { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'new' });
    await recordDecision(sys, { taskId, runId: 'R-001', output: proposal(), outputText: TEXT }); // step-002 proposed
    await submitRun(sys, { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'new' });
    expect(await expectRejected(dataDir, () => recordDecision(sys, { taskId, runId: 'R-002', output: proposal(), outputText: TEXT }))).toMatch(/닫히지 않은 Step\(step-002 proposed\)/);
    expect(await expectRejected(dataDir, () => recordDecision(sys, { taskId, runId: 'R-001', output: proposal({ action: 'ask_human', next_step: undefined, question: { text: '?' } }), outputText: TEXT }))).toMatch(/이미 completed 다/);
  });

  it('거부 — 닫히지 않은 Step 이 있을 때 skill 만인 next_step 도 (G-003 A)', async () => {
    const { dataDir, taskId, sys } = await setupRound('in_review');
    await submitRun(sys, { taskId, role: 'planner', access: 'read', backend: 'fake', sessionPath: 'new' });
    const skillOnly = proposal({ next_step: { skill: 'example@1', params: {} } });
    expect(await expectRejected(dataDir, () => recordDecision(sys, { taskId, runId: 'R-001', output: skillOnly, outputText: TEXT }))).toMatch(/닫히지 않은 Step\(step-001 in_review\)/);
  });

  it('skill 만인 next_step 은 닫히지 않은 Step 이 없을 때 Decision 과 Run 완료만 — Step 을 만들지 않는다', async () => {
    const { store, taskId, sys } = await planning();
    const { decision, step, result } = await recordDecision(sys, { taskId, runId: 'R-001', output: proposal({ next_step: { skill: 'example@1', params: {} } }), outputText: TEXT });
    expect(decision.next_step).toEqual({ skill: 'example@1', params: {} });
    expect(step).toBeUndefined();
    expect((await store.list('step', { taskId })).items).toEqual([]);
    expect(result.events.map((e) => e.type)).toEqual(['run.completed', 'decision.made']);
  });
});

describe('defineStep', () => {
  async function proposed() {
    const p = await planning();
    await recordDecision(p.sys, { taskId: p.taskId, runId: 'R-001', output: proposal(), outputText: TEXT });
    return p;
  }

  it('고치지 않고 확정: step.defined(human_edit false, ref = created_from, actor 사람), step.status_changed proposed → defined', async () => {
    const { store, taskId, human } = await proposed();
    const { step, humanEdit, result } = await defineStep(human, { taskId, stepId: 'step-001', note: '확정' });
    expect(humanEdit).toBe(false);
    expect(step.status).toBe('defined');
    expect(await store.get('step', { taskId, stepId: 'step-001' })).toEqual(step);
    expect(result.events.map((e) => [e.type, e.actor, e.ref, e.data])).toEqual([
      ['step.defined', 'human:tester', 'D-001', { human_edit: false, note: '확정' }],
      ['step.status_changed', 'system', undefined, { from: 'proposed', to: 'defined' }],
    ]);
  });

  it('사람이 고친 정의를 반영하고 human_edit 은 created_from Decision 과 비교해 도구가 정한다 — 같은 정의를 주면 false', async () => {
    const edited = await proposed();
    const r1 = await defineStep(edited.human, { taskId: edited.taskId, stepId: 'step-001', definition: { ...stepDefinition(), goal: '사람이 고친 목표' } });
    expect(r1.humanEdit).toBe(true);
    expect(r1.step.goal).toBe('사람이 고친 목표');
    expect(r1.step.created_from).toBe('D-001');
    const same = await proposed();
    expect((await defineStep(same.human, { taskId: same.taskId, stepId: 'step-001', definition: stepDefinition() })).humanEdit).toBe(false);
  });

  it.each([
    ['actor 가 사람이 아니다', 'system', {}, /human:<id>/],
    ['고친 정의에 status', 'human', { definition: { ...stepDefinition(), status: 'closed' } }, /definition.status: 도구가 채우는 필드다/],
    ['고친 정의에 id', 'human', { definition: { ...stepDefinition(), id: 'step-009' } }, /definition.id: 도구가 채우는 필드다/],
    ['고친 정의가 스키마에 맞지 않다', 'human', { definition: { ...stepDefinition(), goal: undefined } }, /required property 'goal'/],
    ['없는 Step', 'human', { stepId: 'step-009' }, /step-009 가 없다/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, who, patch, reason) => {
    const { dataDir, taskId, sys, human } = await proposed();
    expect(await expectRejected(dataDir, () => defineStep(who === 'human' ? human : sys, { taskId, stepId: 'step-001', ...(patch as object) }))).toMatch(reason);
  });

  it('거부 — 표에 없는 전이: 이미 defined 인 Step 을 다시 확정', async () => {
    const { dataDir, taskId, human } = await proposed();
    await defineStep(human, { taskId, stepId: 'step-001' });
    expect(await expectRejected(dataDir, () => defineStep(human, { taskId, stepId: 'step-001' }))).toMatch(/defined 다 — defineStep 는 proposed 에서만/);
  });
});

/** step-001 이 in_review(G-001 pass, v1). */
async function inReview() {
  const s = await setupRound('defined');
  const { refs } = await workerRound(s.sys, s.taskId);
  const runId = await submitReviewer(s.sys, s.taskId);
  await recordGate(s.sys, { taskId: s.taskId, stepId: 'step-001', reviewerRunId: runId, artifactRefs: refs, output: reviewerOutput('pass') });
  return { ...s, refs };
}

describe('requestRevision', () => {
  it('in_review → revising: Feedback(revision_request), feedback.added, step.status_changed', async () => {
    const { store, taskId, human, refs } = await inReview();
    const { feedback, result } = await requestRevision(human, { taskId, stepId: 'step-001', artifactRef: refs[0]!, text: '고쳐 주세요' });
    expect(feedback).toEqual({ id: 'F-001', task_id: taskId, step_id: 'step-001', kind: 'revision_request', channel: 'review', target: { artifact_ref: refs[0] }, text: '고쳐 주세요', author: 'tester', created_at: NOW_SECONDS });
    expect(result.events.map((e) => [e.type, e.actor, e.ref, e.data])).toEqual([
      ['feedback.added', 'human:tester', 'F-001', { kind: 'revision_request' }],
      ['step.status_changed', 'system', undefined, { from: 'in_review', to: 'revising' }],
    ]);
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('revising');
  });

  it.each([
    ['actor 가 사람이 아니다', (r: string[]) => ({ artifactRef: r[0] }), 'system', /human:<id>/],
    ['로컬 경로 참조', () => ({ artifactRef: 'C:\\x\\plan.md' }), 'human', /artifact:\/\/<task>/],
    ['없는 버전', (r: string[]) => ({ artifactRef: r[0]!.replace('@v1', '@v3') }), 'human', /가 없다/],
    ['다른 Step', (r: string[]) => ({ artifactRef: r[0]!.replace('step-001', 'step-002') }), 'human', /의 것이 아니다/],
    ['빈 text', (r: string[]) => ({ artifactRef: r[0], text: ' ' }), 'human', /text: 비어 있다/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, patch, who, reason) => {
    const { dataDir, taskId, sys, human, refs } = await inReview();
    expect(await expectRejected(dataDir, () => requestRevision(who === 'human' ? human : sys, { taskId, stepId: 'step-001', text: 't', ...(patch(refs) as { artifactRef: string }) }))).toMatch(reason);
  });

  it('거부 — 표에 없는 전이(checking 에서)와 가장 새 버전이 아닌 참조', async () => {
    const { dataDir, taskId, sys, human, refs } = await inReview();
    await requestRevision(human, { taskId, stepId: 'step-001', artifactRef: refs[0]!, text: 't' });
    const { refs: v2 } = await workerRound(sys, taskId, SHA_C); // revising → checking, v2
    expect(await expectRejected(dataDir, () => requestRevision(human, { taskId, stepId: 'step-001', artifactRef: v2[0]!, text: 't' }))).toMatch(/checking 다 — requestRevision 는 in_review 에서만/);
    const runId = await submitReviewer(sys, taskId);
    await recordGate(sys, { taskId, stepId: 'step-001', reviewerRunId: runId, artifactRefs: v2, output: reviewerOutput('pass') });
    expect(await expectRejected(dataDir, () => requestRevision(human, { taskId, stepId: 'step-001', artifactRef: refs[0]!, text: 't' }))).toMatch(/가장 새 버전이 아니다 \(가장 새 것은 v2\)/);
  });
});

describe('approveStep', () => {
  it('--gate 의 버전을 승인: Feedback×2, feedback.added×2, artifact.approved×2(data.gate), in_review → approved(official_gate) → closed 를 한 commit 에', async () => {
    const { store, taskId, human, refs } = await inReview();
    const { feedback, approved, result } = await approveStep(human, { taskId, stepId: 'step-001', gateId: 'G-001', text: '승인.' });
    expect(approved).toEqual(refs);
    expect(feedback.map((f) => [f.id, f.kind, f.target?.artifact_ref, f.author])).toEqual([
      ['F-001', 'approval', refs[0], 'tester'],
      ['F-002', 'approval', refs[1], 'tester'],
    ]);
    expect(result.events.map((e) => [e.type, e.actor, e.ref, e.data])).toEqual([
      ['feedback.added', 'human:tester', 'F-001', { kind: 'approval' }],
      ['feedback.added', 'human:tester', 'F-002', { kind: 'approval' }],
      ['artifact.approved', 'human:tester', refs[0], { gate: 'G-001' }],
      ['artifact.approved', 'human:tester', refs[1], { gate: 'G-001' }],
      ['step.status_changed', 'system', undefined, { from: 'in_review', to: 'approved', official_gate: 'G-001' }],
      ['step.status_changed', 'system', undefined, { from: 'approved', to: 'closed' }],
    ]);
    expect(new Set(result.events.map((e) => e.commit_id)).size).toBe(1);
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('closed');
    expect((await store.get('artifact', { ref: refs[0]! }))!.approved).toBeUndefined(); // meta 는 고치지 않는다(ADR-0015)
  });

  it('거부 — 사람이 본 Gate 뒤에 새 버전이 생겼다 (F-001 (2)): G-001 의 v1 은 더 이상 가장 새 버전이 아니다', async () => {
    const { dataDir, taskId, sys, human, refs } = await inReview();
    await requestRevision(human, { taskId, stepId: 'step-001', artifactRef: refs[0]!, text: 't' });
    const { refs: v2 } = await workerRound(sys, taskId, SHA_C);
    const runId = await submitReviewer(sys, taskId);
    await recordGate(sys, { taskId, stepId: 'step-001', reviewerRunId: runId, artifactRefs: v2, output: reviewerOutput('pass') }); // G-002, in_review
    expect(await expectRejected(dataDir, () => approveStep(human, { taskId, stepId: 'step-001', gateId: 'G-001', text: '승인' }))).toMatch(/plan@v1 는 plan 의 가장 새 버전이 아니다 \(가장 새 것은 v2\)/);
    const { approved } = await approveStep(human, { taskId, stepId: 'step-001', gateId: 'G-002', text: '승인' });
    expect(approved).toEqual(v2);
  });

  it.each([
    ['--gate 가 없다', 'human', { gateId: undefined }, /사람이 본 Gate 를 준다/],
    ['--gate 가 정규형이 아니다', 'human', { gateId: 'G1' }, /정규형이 아니다/],
    ['없는 Gate', 'human', { gateId: 'G-007' }, /G-007 가 없다/],
    ['actor 가 사람이 아니다', 'system', {}, /human:<id>/],
    ['빈 text', 'human', { text: '' }, /text: 비어 있다/],
    ['입력의 시각', 'human', { at: 'x' }, /at: 도구가 채우는 필드다/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, who, patch, reason) => {
    const { dataDir, taskId, sys, human } = await inReview();
    expect(await expectRejected(dataDir, () => approveStep(who === 'human' ? human : sys, { taskId, stepId: 'step-001', gateId: 'G-001', text: '승인', ...(patch as object) } as never))).toMatch(reason);
  });

  it('거부 — fail 인 Gate / 표에 없는 전이(revising·proposed 에서) / outputs 이름이 빠진 Gate', async () => {
    const s = await setupRound('defined');
    const { refs } = await workerRound(s.sys, s.taskId);
    const r1 = await submitReviewer(s.sys, s.taskId);
    await recordGate(s.sys, { taskId: s.taskId, stepId: 'step-001', reviewerRunId: r1, artifactRefs: refs, output: reviewerOutput('fail') }); // G-001 fail → revising
    expect(await expectRejected(s.dataDir, () => approveStep(s.human, { taskId: s.taskId, stepId: 'step-001', gateId: 'G-001', text: '승인' }))).toMatch(/revising 다 — approveStep 는 in_review·approved 에서만/);
    const { refs: v2 } = await workerRound(s.sys, s.taskId, SHA_C);
    const r2 = await submitReviewer(s.sys, s.taskId);
    await recordGate(s.sys, { taskId: s.taskId, stepId: 'step-001', reviewerRunId: r2, artifactRefs: [v2[0]!], output: reviewerOutput('pass') }); // G-002: plan 만
    expect(await expectRejected(s.dataDir, () => approveStep(s.human, { taskId: s.taskId, stepId: 'step-001', gateId: 'G-001', text: '승인' }))).toMatch(/G-001 는 fail 다/);
    expect(await expectRejected(s.dataDir, () => approveStep(s.human, { taskId: s.taskId, stepId: 'step-001', gateId: 'G-002', text: '승인' }))).toMatch(/change 이 0 개다/);
    const p = await planning();
    await recordDecision(p.sys, { taskId: p.taskId, runId: 'R-001', output: proposal(), outputText: TEXT });
    expect(await expectRejected(p.dataDir, () => approveStep(p.human, { taskId: p.taskId, stepId: 'step-001', gateId: 'G-001', text: '승인' }))).toMatch(/proposed 다 — approveStep/);
  });
});

describe('addFeedback', () => {
  it('질문·지시·요구사항·답 — Feedback 과 feedback.added(data.kind, channel), status 는 그대로', async () => {
    const { store, taskId, human, refs } = await inReview();
    const { feedback, result } = await addFeedback(human, { taskId, stepId: 'step-001', kind: 'question', channel: 'review', target: { artifactRef: refs[0]!, location: '2절', runId: 'R-001' }, text: '이건 왜?' });
    expect(feedback).toEqual({ id: 'F-001', task_id: taskId, step_id: 'step-001', kind: 'question', channel: 'review', target: { artifact_ref: refs[0], location: '2절', run_id: 'R-001' }, text: '이건 왜?', author: 'tester', created_at: NOW_SECONDS });
    expect(result.events).toEqual([expect.objectContaining({ type: 'feedback.added', actor: 'human:tester', step_id: 'step-001', ref: 'F-001', data: { kind: 'question', channel: 'review' } })]);
    expect((await store.get('step', { taskId, stepId: 'step-001' }))!.status).toBe('in_review');
    const task = await addFeedback(human, { taskId, kind: 'requirement', channel: 'live', text: 'Task 수준 요구' });
    expect(task.feedback.step_id).toBeUndefined();
  });

  it.each([
    ['kind approval (approveStep 이 쓴다)', 'human', { kind: 'approval' }, /approval 는 받지 않는다 — approveStep/],
    ['kind revision_request (requestRevision 이 쓴다)', 'human', { kind: 'revision_request' }, /revision_request 는 받지 않는다 — requestRevision/],
    ['로컬 경로 target', 'human', { target: { artifactRef: 'D:/data/x.md' } }, /artifact:\/\/<task>/],
    ['없는 버전 target', 'human', { target: { artifactRef: 'artifact://T-0001/step-001/plan@v7' } }, /plan@v7 가 없다/],
    ['다른 Step 의 target', 'human', { target: { artifactRef: 'artifact://T-0001/step-002/plan@v1' } }, /T-0001\/step-001 의 것이 아니다/],
    ['다른 Task 의 target', 'human', { stepId: undefined, target: { artifactRef: 'artifact://T-0002/step-001/plan@v1' } }, /T-0001 의 것이 아니다/],
    ['없는 Run target', 'human', { target: { runId: 'R-077' } }, /R-077 가 없다/],
    ['없는 Decision target', 'human', { target: { decisionId: 'D-077' } }, /D-077 가 없다/],
    ['target 의 모르는 필드', 'human', { target: { path: 'C:\\x' } }, /target.path: 모르는 입력이다/],
    ['없는 Step', 'human', { stepId: 'step-009' }, /step-009 가 없다/],
    ['actor 가 사람이 아니다', 'system', {}, /human:<id>/],
  ] as const)('거부 — 아무것도 쓰지 않는다: %s', async (_label, who, patch, reason) => {
    const { dataDir, taskId, sys, human } = await inReview();
    expect(await expectRejected(dataDir, () => addFeedback(who === 'human' ? human : sys, { taskId, stepId: 'step-001', kind: 'question', channel: 'review', text: 'x', ...(patch as object) } as never))).toMatch(reason);
  });

  it('거부 — 가장 새 버전이 아닌 target (G-003 A): v2 가 생긴 뒤의 v1, Step 을 주든 안 주든 kind 가 무엇이든', async () => {
    const { dataDir, taskId, sys, human, refs } = await inReview();
    await requestRevision(human, { taskId, stepId: 'step-001', artifactRef: refs[0]!, text: 't' });
    const { refs: v2 } = await workerRound(sys, taskId, SHA_C); // v2, checking
    for (const [kind, stepId] of [['question', 'step-001'], ['direction', undefined], ['answer', 'step-001']] as const) {
      const input = { taskId, ...(stepId ? { stepId } : {}), kind, channel: 'review' as const, target: { artifactRef: refs[0]! }, text: 'x' };
      expect(await expectRejected(dataDir, () => addFeedback(human, input))).toMatch(/plan@v1 는 plan 의 가장 새 버전이 아니다 \(가장 새 것은 v2\)/);
    }
    const { feedback } = await addFeedback(human, { taskId, stepId: 'step-001', kind: 'question', channel: 'review', target: { artifactRef: v2[0]! }, text: 'x' });
    expect(feedback.target?.artifact_ref).toBe(v2[0]);
  });
});

it('Decision 타입의 packet_gaps 가 없으면 Run 에도 두지 않는다', async () => {
  const { store, taskId, sys } = await planning();
  const out = proposal() as Partial<Decision>;
  delete out.packet_gaps;
  await recordDecision(sys, { taskId, runId: 'R-001', output: out, outputText: TEXT });
  expect(await store.get('run', { taskId, id: 'R-001' })).not.toHaveProperty('packet_gaps');
});
