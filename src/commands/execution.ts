import type { RoleExecutionInput, WorkerExecutionInput, QuestionSettings } from '../types/generated/index.js';
import type { SettingsSelection } from '../settings/types.js';
import { submitWorker } from './worker.js';
import { submitRole, collectExecution } from './roles.js';
import { cancelExecution, sendExecutionMessage } from './execution-control.js';
import { createIntake, submitIntake, collectIntake, confirmIntakeIntent, publishIntake, cancelIntake } from './intake.js';
import { getIntake } from '../queries/intake.js';
import { getExecution, getExecutionLog } from '../queries/execution.js';
import { getExecutionSettings } from '../queries/execution-settings.js';
import { getWorkspace } from '../queries/workspace.js';
import { ExecutionError } from '../runner/types.js';
import { checkKeys } from './common.js';
import { startWorkflow, advance, respondHitl, type WorkflowContext } from './workflow.js';
import { openQuestion } from './question.js';
import { getWorkflow } from '../queries/workflow.js';
import type { HitlTarget, WorkflowInput } from '../types/generated/index.js';

/** Thin, reusable operating entry. It does not choose next steps or run Gates. */
export async function operateExecution(ctx: WorkflowContext, input: {
  action: string; taskId?: string; stepId?: string; runId?: string; role?: SettingsSelection['role'];
  id?: string; version?: number; text?: string; messageId?: string; offset?: number;
  input?: RoleExecutionInput | WorkerExecutionInput;
  config?: WorkflowInput; target?: HitlTarget; response?: 'approve' | 'revise'; destination?: 'worker' | 'reviewer';
  backend?: QuestionSettings['backend']; model?: QuestionSettings['model']; reasoning?: QuestionSettings['reasoning'];
}) {
  checkKeys(input, ['action', 'taskId', 'stepId', 'runId', 'role', 'id', 'version', 'text', 'messageId', 'offset', 'input', 'config', 'target', 'response', 'destination', 'backend', 'model', 'reasoning']);
  const required = (name: 'taskId' | 'stepId' | 'runId' | 'id' | 'text') => {
    const value = input[name]; if (typeof value !== 'string' || !value.trim()) throw new ExecutionError(`${name} is required`); return value;
  };
  if (input.action === 'settings') {
    if (!ctx.settings || !input.role || !['worker', 'reviewer', 'planner', 'intake', 'question'].includes(input.role)) throw new ExecutionError('settings requires a role');
    const task = input.taskId ? await ctx.store.get('task', { taskId: input.taskId }) : undefined;
    if (input.taskId && !task) throw new ExecutionError('Task not found');
    const workspace = task ? await getWorkspace(ctx, task.id) : undefined;
    const candidate = input.stepId && task ? await ctx.store.get('step', { taskId: task.id, stepId: input.stepId }) : undefined;
    const step = input.role === 'question' && candidate && ['proposed', 'cancelled'].includes(candidate.status) ? undefined : candidate;
    return getExecutionSettings({ settings: ctx.settings }, { role: input.role,
      ...(task ? { taskType: step?.task_type ?? task.type } : {}), ...(step?.execution?.[input.role] ? { step: step.execution[input.role]! } : {}),
      ...(workspace?.state === 'ready' ? { workdir: workspace.location.workdir } : {}) });
  }
  if (input.action === 'intake-create') return createIntake(ctx, { text: required('text') });
  if (input.action.startsWith('intake-')) {
    const id = required('id');
    if (input.action === 'intake-start') {
      if (!input.input) throw new ExecutionError('input is required');
      return submitIntake(ctx, { id, input: input.input });
    }
    if (input.action === 'intake-status') return getIntake(ctx, { id });
    if (input.action === 'intake-collect') return collectIntake(ctx, { id });
    if (input.action === 'intake-cancel') return cancelIntake(ctx, { id });
    if (!Number.isSafeInteger(input.version) || input.version! < 1) throw new ExecutionError('version is required');
    if (input.action === 'intake-confirm') return confirmIntakeIntent(ctx, { id, version: input.version! });
    if (input.action === 'intake-publish') return publishIntake(ctx, { id, version: input.version! });
    throw new ExecutionError('Unknown Intake action');
  }
  const taskId = required('taskId');
  if (input.action === 'workflow-start') return startWorkflow(ctx, { taskId, ...(input.config ? { config: input.config } : {}) });
  if (input.action === 'advance') return advance(ctx, { taskId });
  if (input.action === 'hitl') return getWorkflow(ctx, taskId);
  if (input.action === 'respond') {
    if (!input.target || !input.response) throw new ExecutionError('target and response are required');
    return respondHitl(ctx, { taskId, target: input.target, response: input.response, ...(input.text ? { text: input.text } : {}), ...(input.destination ? { destination: input.destination } : {}) });
  }
  if (input.action === 'question') {
    if (!input.target) throw new ExecutionError('target is required');
    return openQuestion(ctx, { taskId, target: input.target, text: required('text'), ...(input.backend ? { backend: input.backend } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}), ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}) });
  }
  const runId = required('runId');
  if (input.action === 'start') {
    if (!input.input) throw new ExecutionError('input is required');
    if (input.role === 'worker') return submitWorker(ctx, { taskId, runId, stepId: required('stepId'), input: input.input as WorkerExecutionInput });
    if (input.role === 'planner' || input.role === 'reviewer') return submitRole(ctx, { taskId, runId, role: input.role, ...(input.stepId ? { stepId: input.stepId } : {}), input: input.input });
    throw new ExecutionError('start requires worker, planner or reviewer');
  }
  if (input.action === 'status') return getExecution(ctx, { taskId, runId });
  if (input.action === 'collect') {
    const result = await collectExecution(ctx, { taskId, runId });
    return (await ctx.store.get('task', { taskId }))?.workflow ? advance(ctx, { taskId }) : result;
  }
  if (input.action === 'cancel') return cancelExecution(ctx, { taskId, runId });
  if (input.action === 'log') return getExecutionLog(ctx, { taskId, runId, ...(input.offset !== undefined ? { offset: input.offset } : {}) });
  if (input.action === 'message') return sendExecutionMessage(ctx, { taskId, runId, text: required('text'), ...(input.messageId ? { messageId: input.messageId } : {}) });
  throw new ExecutionError('Unknown execution action');
}
