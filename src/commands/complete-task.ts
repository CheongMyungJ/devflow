// Task 의 끝 (docs/design/commands.md 6.1·6.2·6.3): completeTask — 사람이 Planner 의 done 을 확정하고 merge 한 뒤 Task 를 닫는다.

import { isCanonicalId } from '../store/refs.js';
import type { CommitResult } from '../store/types.js';
import type { Task } from '../types/generated/index.js';
import { checkKeys, commitAfterReading, humanId, isSha, openTask, rejectIf, tail, withNote } from './common.js';
import type { CommandContext } from './context.js';
import { RejectedInputError } from './errors.js';
import { recordedAt } from './time.js';

export interface CompleteTaskInput {
  taskId: string;
  /** 사람이 확정한 Planner 의 Decision(action done). task.done 의 ref 와 data.confirmed 가 된다. */
  decisionId: string;
  /** task branch 를 합친 commit. repo·branch 는 도구가 Task 의 target(repo, base_branch)에서 채운다. */
  merge: { sha: string; method?: string };
  /** merge 뒤의 확인(무엇을 돌려 무엇을 얻었는가). 비울 수 없다. */
  postMergeCheck: string;
  note?: string;
}

/**
 * Task done: task.yaml(status done)과 task.done(ref = decisionId, data.confirmed, data.merge{repo, branch, sha, method}, data.post_merge_check,
 * data.note) — 한 commit. 데이터의 모양은 옛 기록(T-0002~T-0005 의 task.done)과 같다. system_sha 는 도구가 채우는 devflow 의 HEAD 다 —
 * merge 뒤의 main 에서 부르면 그것이 merge 뒤의 SHA 다(0단계의 규칙).
 * 거부(아무것도 쓰기 전에): actor 가 사람이 아니다, Task 가 없거나 open 이 아니다, Decision 이 없거나 action done 이 아니다,
 * 닫히지 않은(closed·cancelled 가 아닌) Step 이 있다, merge sha 가 줄이지 않은 16진 소문자(40자 또는 64자)가 아니다, postMergeCheck 가 비었다,
 * 도구가 채우는 필드나 모르는 필드가 있다.
 */
export async function completeTask(ctx: CommandContext, input: CompleteTaskInput): Promise<{ task: Task; result: CommitResult }> {
  checkKeys(input, ['taskId', 'decisionId', 'merge', 'postMergeCheck', 'note']);
  if (typeof input.merge !== 'object' || input.merge === null) throw new RejectedInputError(['merge: { sha, method? } 여야 한다']);
  checkKeys(input.merge, ['sha', 'method'], 'merge');
  humanId(ctx);
  const { taskId, decisionId } = input;
  const reasons: string[] = [];
  if (typeof decisionId !== 'string' || !isCanonicalId('decision', decisionId)) reasons.push(`decisionId: ${JSON.stringify(decisionId)} 는 D-NNN 의 정규형이 아니다`);
  if (typeof input.merge.sha !== 'string' || !isSha(input.merge.sha)) reasons.push(`merge.sha: ${JSON.stringify(input.merge.sha)} 는 줄이지 않은 commit SHA(40자 또는 64자 16진 소문자)가 아니다`);
  if (input.merge.method !== undefined && (typeof input.merge.method !== 'string' || input.merge.method.trim() === '')) reasons.push('merge.method: 비어 있다');
  if (typeof input.postMergeCheck !== 'string' || input.postMergeCheck.trim() === '') reasons.push('postMergeCheck: 비어 있다 — merge 뒤에 무엇을 확인했는지 적는다');
  rejectIf(reasons);
  const at = recordedAt(ctx.clock);
  let task!: Task;

  const result = await commitAfterReading(ctx, taskId, async () => {
    const current = await openTask(ctx, taskId);
    const decision = await ctx.store.get('decision', { taskId, id: decisionId });
    if (decision === undefined) throw new RejectedInputError([`decisionId: ${taskId} 에 ${decisionId} 가 없다`]);
    if (decision.action !== 'done') throw new RejectedInputError([`decisionId: ${decisionId} 의 action 은 ${decision.action} 다 — done 인 Decision 을 사람이 확정한 뒤에 닫는다`]);
    const { items } = await ctx.store.list('step', { taskId });
    const open = items.filter((s) => s.status !== 'closed' && s.status !== 'cancelled');
    if (open.length) throw new RejectedInputError([`taskId: 닫히지 않은 Step(${open.map((s) => `${s.id} ${s.status}`).join(', ')})이 있다`]);
    task = { ...current, status: 'done' };
    const merge = {
      repo: current.target.repo,
      branch: current.target.base_branch,
      sha: input.merge.sha,
      ...(input.merge.method !== undefined ? { method: input.merge.method } : {}),
    };
    return () => ({
      writes: [{ kind: 'task', value: task }],
      events: [
        {
          type: 'task.done',
          actor: ctx.actor,
          ref: decisionId,
          data: withNote({ confirmed: decisionId, merge, post_merge_check: input.postMergeCheck }, input.note),
          ...tail(ctx, at),
        },
      ],
    });
  });
  return { task, result };
}
