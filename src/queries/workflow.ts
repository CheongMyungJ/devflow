import type { Store } from '../store/types.js';
import { ExecutionError } from '../runner/types.js';
import { blobRef } from '../store/blob-ref.js';

/** Human-facing result material, read through Store only at the query boundary. */
export async function getWorkflow(ctx: { store: Store }, taskId: string) {
  const task = await ctx.store.get('task', { taskId });
  if (!task) throw new ExecutionError('Task not found');
  const workflow = task.workflow;
  const target = workflow?.pending;
  const step = workflow?.step_id ? await ctx.store.get('step', { taskId, stepId: workflow.step_id }) : undefined;
  const decision = target?.decision_id ? await ctx.store.get('decision', { taskId, id: target.decision_id }) : undefined;
  const gate = target?.gate_id && target.step_id ? await ctx.store.get('gate_result', { taskId, stepId: target.step_id, id: target.gate_id }) : undefined;
  const artifacts = [];
  for (const ref of target?.artifact_refs ?? workflow?.artifact_refs ?? []) {
    const artifact = await ctx.store.get('artifact', { ref });
    if (!artifact) throw new ExecutionError('Pinned Artifact is missing');
    const contents = [];
    for (const key of new Set([artifact.content_key, artifact.work_notes_key].filter((key): key is string => !!key))) {
      const bytes = await ctx.store.getBlob(key);
      if (!bytes) throw new ExecutionError('Pinned Artifact content is missing');
      contents.push({ key, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    }
    artifacts.push({ artifact, contents });
  }
  const run = target?.run_id ? await ctx.store.get('run', { taskId, id: target.run_id }) : undefined;
  const output = run ? await ctx.store.getBlob(blobRef({ taskId, ...(run.step_id ? { stepId: run.step_id } : {}), runId: run.id }, run.role === 'planner' ? 'output.yaml' : 'output.json')) : undefined;
  return { taskId, status: task.status, workflow, step, target, decision, gate, artifacts,
    ...(output ? { output: new TextDecoder().decode(output) } : {}),
    choices: target ? ['승인', '수정 요청', ...(target.role !== 'artifact' ? ['질문 CLI 열기'] : [])] : [],
    notice: '질문 시점의 결과 기준. 질문 대화와 종료는 승인이나 수정 요청이 아닙니다.' };
}
