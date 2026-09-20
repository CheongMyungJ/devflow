import { randomUUID } from 'node:crypto';
import type { NewEvent } from '../store/types.js';
import type { WorkspacePreparation } from '../types/generated/index.js';
import { WorkspaceError, WorkspacePreparationError } from '../workspace/errors.js';
import { workspaceRecord } from '../workspace/records.js';
import type { Workspace, WorkspaceLocation } from '../workspace/types.js';
import { checkKeys, openTask, tail } from './common.js';
import type { CommandContext } from './context.js';
import { recordedAt } from './time.js';
import { CommitOutcomeUnknownError } from '../store/errors.js';
import { confirmOutcome } from './outcome.js';

export interface WorkspaceCommandContext extends CommandContext { workspace: Workspace }
export interface PreparedWorkspace { preparation: WorkspacePreparation; location: WorkspaceLocation }

/** CAS 충돌은 자동 재시도하지 않는다. 알 수 없는 commit 결과만 기존 계약대로 확인한다. */
async function record(ctx: CommandContext, taskId: string, expectedLastSeq: number, event: NewEvent): Promise<void> {
  try { await ctx.store.commit(taskId, { expectedLastSeq, events: [event] }); }
  catch (error) {
    if (!(error instanceof CommitOutcomeUnknownError)) throw error;
    await confirmOutcome(ctx.store, error, [event]);
  }
}

/** 다단계 command: 의도 commit → Git → 완료 commit. 실패는 변경 없음을 뜻하지 않는다(ADR-0018). */
export async function prepareWorkspace(ctx: WorkspaceCommandContext, input: { taskId: string }): Promise<PreparedWorkspace> {
  let phase: 'before_start' | 'interrupted' = 'before_start';
  try {
    checkKeys(input, ['taskId']);
    const { taskId } = input;
    const events = await ctx.store.readEvents(taskId);
    const task = await openTask(ctx, taskId);
    let { preparation, completed } = workspaceRecord(task, events);
    if (preparation) phase = 'interrupted';
    if (!preparation) {
      if (!task.target.base_source) throw new WorkspaceError('configuration', 'base_source 없는 옛 Task는 자동 준비하지 않는다. 출처를 명시한 새 Task가 필요하다');
      const baseSha = await ctx.workspace.resolveBase(task);
      preparation = {
        workspace_id: randomUUID(), task_id: taskId, repo: task.target.repo, base_branch: task.target.base_branch,
        base_source: task.target.base_source, task_branch: task.target.task_branch, base_sha: baseSha,
      };
      // commit 결과를 알 수 없을 수도 있으므로 제출 전부터 변경 가능성을 보고한다.
      phase = 'interrupted';
      await record(ctx, taskId, events.at(-1)?.seq ?? 0, {
        type: 'workspace.prepare_requested', actor: 'system', data: { ...preparation }, ...tail(ctx, recordedAt(ctx.clock)),
      });
    }
    if (completed) {
      const state = await ctx.workspace.inspect(preparation);
      if (state.state !== 'ready') throw new WorkspaceError('manual', state.state === 'blocked' ? state.reason : '완료된 작업공간이 없다. 자동 재생성하지 않는다');
      return { preparation, location: state.location };
    }
    const location = await ctx.workspace.ensure(preparation);
    // Git 실행 중 Task가 바뀌었다면 최신 상태를 다시 검사한다. 결과물은 지우지 않는다.
    const after = await ctx.store.readEvents(taskId);
    const current = await openTask(ctx, taskId);
    const state = workspaceRecord(current, after);
    if (state.preparation?.workspace_id !== preparation.workspace_id) throw new WorkspaceError('manual', '준비 중 요청이 변경되었다');
    if (!state.completed) await record(ctx, taskId, after.at(-1)?.seq ?? 0, {
      type: 'workspace.prepared', actor: 'system', data: { workspace_id: preparation.workspace_id }, ...tail(ctx, recordedAt(ctx.clock)),
    });
    return { preparation, location };
  } catch (cause) {
    throw new WorkspacePreparationError(phase, cause);
  }
}
