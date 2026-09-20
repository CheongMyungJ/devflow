import { ExecutionError } from '../types.js';
import type { ExecutionSettings } from '../../types/generated/index.js';

export function validateClaudeModelSettings(request: Pick<ExecutionSettings, 'model' | 'reasoning'>) {
  if (request.reasoning && (!request.model || !/^(sonnet|opus|fable|claude-(sonnet|opus|fable))/.test(request.model) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoning))) throw new ExecutionError('unsupported Claude model/reasoning combination; specify a supported model and effort');
  if (request.reasoning && ['xhigh', 'max'].includes(request.reasoning) && request.model?.includes('sonnet')) throw new ExecutionError('unsupported Sonnet effort; use low, medium or high');
}
