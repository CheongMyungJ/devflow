import { TaskNotFoundError } from '../store/errors.js';
import type { Store } from '../store/types.js';
import { workspaceRecord } from '../workspace/records.js';
import type { Workspace } from '../workspace/types.js';

/** 실행 위치를 포함할 수 있는 조회 결과다. 결과를 공유 상태 기록에 저장하지 않는다. */
export async function getWorkspace(ctx: { store: Store; workspace: Workspace }, taskId: string) {
  const events = await ctx.store.readEvents(taskId);
  const task = await ctx.store.get('task', { taskId });
  if (!task) throw new TaskNotFoundError(taskId);
  try {
    const record = workspaceRecord(task, events);
    if (!record.preparation) return { state: 'unprepared' as const };
    const inspection = await ctx.workspace.inspect(record.preparation);
    if (inspection.state === 'ready') return {
      state: record.completed ? 'ready' as const : 'pending_record' as const,
      preparation: record.preparation, location: inspection.location,
    };
    if (inspection.state === 'blocked') return { ...inspection, preparation: record.preparation };
    return { state: record.completed ? 'blocked' as const : 'pending' as const,
      reason: record.completed ? '완료된 작업공간이 없다. 자동 재생성하지 않는다' : '같은 준비 명령으로 이어갈 수 있다', preparation: record.preparation };
  } catch (error) {
    return { state: 'blocked' as const, reason: error instanceof Error ? error.message : String(error) };
  }
}
