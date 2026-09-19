// confirmOutcome 을 실제 파일 구현체 위에서 (docs/design/commands.md 3절 — T-0005 AC3).
// 결과를 알 수 없는 commit 을 실제로 만들고, 그 자리에 "식별자만 다르고 내용이 같은" 다른 commit 의 이벤트를 실제로 기록한 뒤 판정한다.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { confirmOutcome } from '../../src/commands/index.js';
import { CommitOutcomeUnknownError, StoreUnavailableError } from '../../src/store/errors.js';
import { nodeFileOps } from '../../src/store/file/index.js';
import type { NewEvent } from '../../src/store/types.js';
import { createSample, ioError, newStore, opsWith, sampleTask, tempDataDir } from '../store/helpers.js';

const isEvents = (p: string) => p.endsWith('events.jsonl');
const sent: [NewEvent, NewEvent] = [
  { type: 'feedback.added', actor: 'human:tester', at: '2026-09-19T00:00:00Z', ref: 'F-001' },
  { type: 'artifact.approved', actor: 'human:tester', at: '2026-09-19T00:00:00Z', ref: 'artifact://T-0001/step-001/plan@v1' },
];

/** commit 이 결과를 알 수 없게 끝나는 Store. landed 면 이벤트가 모두 쓰인 뒤, 아니면 하나도 쓰이지 않은 채 append 가 실패하고, 그 뒤 로그를 읽지도 못한다. */
function flakyStore(dataDir: string, landed: boolean) {
  let failed = false;
  return newStore(dataDir, {
    ops: opsWith({
      append: async (p, d) => {
        if (!isEvents(p) || failed) return nodeFileOps.append(p, d);
        if (landed) await nodeFileOps.append(p, d);
        failed = true;
        throw ioError('EIO');
      },
      readFile: async (p) => (failed && isEvents(p) ? Promise.reject(ioError('EIO')) : nodeFileOps.readFile(p)),
    }),
  });
}

async function unknownCommit(dataDir: string, taskId: string, landed: boolean): Promise<CommitOutcomeUnknownError> {
  const error = await flakyStore(dataDir, landed).commit(taskId, { events: sent }).catch((e) => e);
  expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
  return error;
}

/** 식별자가 없는 옛 이벤트만 있는 Task (T-0005 이전의 기록, 0단계의 운영 스크립트가 쓴 것처럼). 파일을 직접 쓴다. */
function oldTask(dataDir: string): string {
  const taskId = 'T-0001';
  mkdirSync(join(dataDir, taskId));
  writeFileSync(join(dataDir, taskId, 'task.yaml'), stringify(sampleTask(taskId)));
  const lines = [
    { seq: 1, task_id: taskId, type: 'task.created', actor: 'human:tester', at: '2026-01-01T00:00:00Z' },
    { seq: 2, task_id: taskId, type: 'decision.made', actor: 'role:planner', at: '2026-01-01T00:01:00Z', ref: 'D-001' },
  ];
  writeFileSync(join(dataDir, taskId, 'events.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return taskId;
}

describe('confirmOutcome: commit 식별자로 판정한다 (commands.md 3절)', () => {
  it('같은 자리에 내용이 같은 다른 commit 의 이벤트가 있으면 성립하지 않은 것이다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const unknown = await unknownCommit(dataDir, task.id, false);

    // 다른 호출자가 같은 내용을 같은 자리에 기록한다(다음 접근의 복구가 결과를 알 수 없던 commit 을 되돌린 뒤)
    const store = newStore(dataDir);
    const other = await store.commit(task.id, { events: sent });
    expect(other.events[0]!.seq).toBe(unknown.firstSeq);
    // 실제로 그 상황인가: 그 자리의 이벤트는 식별자만 다르고 나머지는 보낸 것과 같다 — T-0001 의 내용 비교라면 성립으로 판정했다
    const there = await store.readEvents(task.id, { afterSeq: unknown.firstSeq - 1 });
    expect(there.map(({ seq, task_id, commit_id, ...rest }) => rest)).toEqual(sent);
    expect(there.every((e) => e.commit_id !== unknown.commitId)).toBe(true);

    const error = await confirmOutcome(store, unknown, sent).catch((e) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect(error.cause).toBe(unknown);
  });

  it('자기 식별자의 이벤트가 그 자리에 있으면 성립한 것이다 → 그 이벤트들을 돌려준다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const unknown = await unknownCommit(dataDir, task.id, true);
    const events = await confirmOutcome(newStore(dataDir), unknown, sent);
    expect(events.map((e) => [e.seq, e.commit_id])).toEqual([
      [unknown.firstSeq, unknown.commitId],
      [unknown.firstSeq + 1, unknown.commitId],
    ]);
  });

  it('식별자가 없는 옛 이벤트가 있는 Task 에서도 판정이 맞다 — 성립한 것은 성립, 그 자리의 옛 모양 이벤트는 자기 것이 아니다', async () => {
    const landedDir = tempDataDir();
    const landedTask = oldTask(landedDir);
    const landed = await unknownCommit(landedDir, landedTask, true);
    expect(landed.firstSeq).toBe(3);
    expect((await confirmOutcome(newStore(landedDir), landed, sent)).map((e) => e.seq)).toEqual([3, 4]);

    const lostDir = tempDataDir();
    const lostTask = oldTask(lostDir);
    const lost = await unknownCommit(lostDir, lostTask, false);
    const store = newStore(lostDir);
    await store.readEvents(lostTask); // 다음 접근이 결과를 알 수 없던 commit 을 되돌린다
    // 0단계의 운영 스크립트처럼 식별자 없이 같은 내용을 같은 자리에 덧붙인다
    appendFileSync(join(lostDir, lostTask, 'events.jsonl'), sent.map((e, i) => `${JSON.stringify({ seq: 3 + i, task_id: lostTask, ...e })}\n`).join(''));
    expect((await store.readEvents(lostTask)).length).toBe(4);
    await expect(confirmOutcome(store, lost, sent)).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});
