// CommitOutcomeUnknownError 뒤의 확인 절차 (docs/design/commands.md 3절).

import { isDeepStrictEqual } from 'node:util';
import { CommitOutcomeUnknownError, SchemaViolationError, StoreUnavailableError, TaskNotFoundError } from '../store/errors.js';
import type { NewEvent, Store } from '../store/types.js';
import type { Event } from '../types/generated/index.js';

/**
 * 결과를 알 수 없는 commit 이 성립했는지 commit 식별자로 확인한다 (commands.md 3절의 1~6).
 * firstSeq 부터 읽어 commit_id 가 오류의 commitId 와 같은 이벤트를 고른다.
 * - 하나도 없으면 성립하지 않았다 → StoreUnavailableError(기록 안 됨). 그 자리에 내용이 같은 이벤트가 있어도 식별자가 다르면 남의 commit 이다.
 * - 보낸 개수만큼 firstSeq 부터 이어지고 식별자를 뺀 내용이 보낸 것과 같으면 성립했다 → 그 이벤트들을 돌려준다.
 * - 식별자가 같은데 그렇지 않으면 Store 의 계약이 깨진 것이다 → SchemaViolationError(read). 고치려 하지 않는다.
 * - 읽기조차 실패하면 여전히 알 수 없다 → 원래의 CommitOutcomeUnknownError.
 * 식별자가 없는 옛 이벤트는 어떤 식별자와도 같지 않으므로 골라지지 않는다.
 */
export async function confirmOutcome(store: Store, unknown: CommitOutcomeUnknownError, sent: readonly NewEvent[]): Promise<Event[]> {
  let landed: Event[];
  try {
    landed = await store.readEvents(unknown.taskId, { afterSeq: unknown.firstSeq - 1 });
  } catch (error) {
    if (error instanceof TaskNotFoundError) landed = [];
    else throw unknown; // 아직도 알 수 없다
  }

  const mine = landed.filter((event) => event.commit_id === unknown.commitId);
  if (mine.length === 0) throw new StoreUnavailableError(`commit ${unknown.commitId} on ${unknown.taskId} did not land`, { cause: unknown });

  const intact =
    mine.length === sent.length &&
    mine.every((event, i) => {
      const { seq, task_id, commit_id, ...rest } = event;
      return seq === unknown.firstSeq + i && task_id === unknown.taskId && isDeepStrictEqual(rest, withoutUndefined(sent[i]!));
    });
  if (intact) return mine;
  throw new SchemaViolationError('read', `commit ${unknown.commitId} on ${unknown.taskId}`, [
    {
      path: '',
      message: `${mine.length} event(s) carry this commit id (seq ${mine.map((e) => e.seq).join(', ')}) but ${sent.length} were sent from seq ${unknown.firstSeq}, or their content differs. 자동으로 고치지 않는다`,
    },
  ]);
}

/** 저장된 이벤트에는 undefined 인 속성이 없다(JSON). 비교 전에 맞춘다. */
function withoutUndefined(event: NewEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}
