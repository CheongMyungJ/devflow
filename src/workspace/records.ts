import { loadSchemas } from '../schema/registry.mjs';
import type { Event, Task, WorkspacePreparation } from '../types/generated/index.js';
import { WorkspaceError } from './errors.js';

/** 이벤트 해석은 commands/queries가 공유한다. 경로와 파일 포맷을 모른다. */
export function workspaceRecord(task: Task, events: Event[]): { preparation?: WorkspacePreparation; completed: boolean } {
  const requests = events.filter((e) => e.type === 'workspace.prepare_requested');
  const completions = events.filter((e) => e.type === 'workspace.prepared');
  if (requests.length > 1 || completions.length > 1) throw new WorkspaceError('manual', 'Workspace 준비 기록이 중복되어 있다');
  const request = requests[0];
  if (!request) {
    if (completions.length) throw new WorkspaceError('manual', '준비 의도 없이 완료 기록만 있다');
    return { completed: false };
  }
  const validate = loadSchemas().validator('workspace-preparation');
  if (!validate(request.data)) throw new WorkspaceError('manual', 'Workspace 준비 기록의 스키마가 올바르지 않다');
  const preparation = request.data as unknown as WorkspacePreparation;
  if (preparation.task_id !== task.id || preparation.repo !== task.target.repo || preparation.task_branch !== task.target.task_branch
    || preparation.base_branch !== task.target.base_branch || preparation.base_source !== task.target.base_source) {
    throw new WorkspaceError('manual', 'Task와 Workspace 준비 기록이 다르다');
  }
  const completion = completions[0];
  if (completion && (completion.seq <= request.seq || (completion.data as Record<string, unknown> | undefined)?.['workspace_id'] !== preparation.workspace_id)) {
    throw new WorkspaceError('manual', 'Workspace 완료 기록이 준비 요청과 다르다');
  }
  return { preparation, completed: !!completion };
}
