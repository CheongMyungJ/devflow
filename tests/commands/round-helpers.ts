// Step 한 바퀴 command 의 테스트가 함께 쓰는 준비 (T-0006 step-004). 모든 기록은 임시 디렉터리의 Store 에만 쓴다.
import { expect } from 'vitest';
import type { CommandContext } from '../../src/commands/index.js';
import { completeRun, RejectedInputError, submitRun } from '../../src/commands/index.js';
import type { Store } from '../../src/store/types.js';
import type { Step } from '../../src/types/generated/index.js';
import { contentSnapshot, createSample, newStore, tempDataDir } from '../store/helpers.js';
import { event, step } from '../store/records.js';

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);
export const NOW = '2026-09-19T12:34:56.789Z';
export const NOW_SECONDS = '2026-09-19T12:34:56Z';
export const clock = { now: () => new Date(NOW) };

export const ctxOf = (store: Store, actor = 'system'): CommandContext => ({ store, clock, actor, systemSha: SHA_A });

/** Task 하나와 status 가 주어진 step-001(outputs: plan 문서, change 코드 변경). */
export async function setupRound(status: Step['status'] = 'defined') {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  const task = await createSample(store);
  await store.commit(task.id, { writes: [{ kind: 'step', value: step(task.id, 'step-001', status) }], events: [event('step.defined', { step_id: 'step-001' })] });
  return { dataDir, store, taskId: task.id, sys: ctxOf(store), human: ctxOf(store, 'human:tester') };
}

export const workerOutput = (gaps: string[] = ['패킷에 X 가 없었다']) => JSON.stringify({ summary: '요약', packet_gaps: gaps });

export const reviewerOutput = (verdict: 'pass' | 'fail' = 'pass', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    verdict,
    checks: [{ kind: 'deterministic', name: 'test', result: verdict }],
    done_when: [{ condition: '예시 문서가 있다', met: verdict === 'pass' }],
    comments: [{ severity: 'note', class: 'C', text: '작은 것' }],
    packet_gaps: [],
    ...extra,
  });

export const artifactsOf = (head = SHA_B) => [
  { name: 'plan', source: 'blob:work-notes' },
  { name: 'change', source: `code:${SHA_A}..${head}` },
];

/** Worker Run 을 제출하고 완료해 Step 을 checking 으로(defined·running·revising 에서). 새 산출물의 참조를 돌려준다. */
export async function workerRound(sys: CommandContext, taskId: string, head = SHA_B) {
  const { run } = await submitRun(sys, { taskId, stepId: 'step-001', role: 'worker', access: 'write', backend: 'fake', sessionPath: 'new' });
  const { artifacts } = await completeRun(sys, { taskId, runId: run.id, workerOutput: workerOutput(), workNotes: '# 노트\n', artifacts: artifactsOf(head) });
  return { runId: run.id, refs: artifacts.map((a) => a.ref) };
}

export async function submitReviewer(sys: CommandContext, taskId: string) {
  return (await submitRun(sys, { taskId, stepId: 'step-001', role: 'reviewer', access: 'read', backend: 'fake', sessionPath: 'new' })).run.id;
}

/** 거부되고(RejectedInputError 또는 주어진 오류) 데이터 디렉터리가 한 바이트도 바뀌지 않았다. 거부 까닭을 돌려준다. */
export async function expectRejected(dataDir: string, work: () => Promise<unknown>, errorClass: new (...args: never[]) => Error = RejectedInputError): Promise<string> {
  const before = contentSnapshot(dataDir);
  const error = await work().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'was not rejected').toBeInstanceOf(errorClass);
  expect(contentSnapshot(dataDir)).toEqual(before);
  return error instanceof RejectedInputError ? error.reasons.join('\n') : String((error as Error).message);
}
