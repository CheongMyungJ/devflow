// CommitOutcomeUnknownError 뒤의 확인 절차 (docs/design/commands.md 3절).

import { isDeepStrictEqual } from 'node:util';
import { CommitOutcomeUnknownError, StoreUnavailableError, TaskNotFoundError } from '../store/errors.js';
import type { NewEvent, Store } from '../store/types.js';
import type { Event } from '../types/generated/index.js';

/**
 * 결과를 알 수 없는 commit 이 성립했는지 확인한다.
 * firstSeq 부터의 이벤트가 보낸 것과 내용까지 같으면 성립한 것이고 그 이벤트들을 돌려준다.
 * 성립하지 않았으면 StoreUnavailableError(기록 안 됨)를, 확인조차 할 수 없으면 원래의 오류를 던진다.
 *
 * 내용만 비교하므로 "같은 내용을 보낸 다른 호출자" 와 구별하지 못한다. 그래도 안전한 이유:
 * 같은 seq 자리에 같은 내용이 기록되었다면 Task 의 상태는 이 호출자가 원한 그대로다.
 */
export async function confirmOutcome(store: Store, unknown: CommitOutcomeUnknownError, sent: readonly NewEvent[]): Promise<Event[]> {
  let landed: Event[];
  try {
    landed = await store.readEvents(unknown.taskId, { afterSeq: unknown.firstSeq - 1 });
  } catch (error) {
    if (error instanceof TaskNotFoundError) landed = [];
    else throw unknown; // 아직도 알 수 없다
  }

  const mine = landed.slice(0, sent.length);
  const same =
    mine.length === sent.length &&
    mine.every((event, i) => {
      const { seq, task_id, ...rest } = event;
      return seq === unknown.firstSeq + i && task_id === unknown.taskId && isDeepStrictEqual(rest, withoutUndefined(sent[i]!));
    });
  if (same) return mine;
  throw new StoreUnavailableError(`commit on ${unknown.taskId} did not land`, { cause: unknown });
}

/** 저장된 이벤트에는 undefined 인 속성이 없다(JSON). 비교 전에 맞춘다. */
function withoutUndefined(event: NewEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}
