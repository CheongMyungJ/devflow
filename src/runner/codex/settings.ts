import { ExecutionError } from '../types.js';
import type { ExecutionSettings } from '../../types/generated/index.js';

/** The same adapter compatibility check applies to managed roles and native questions. */
export function validateCodexModelSettings(request: Pick<ExecutionSettings, 'model' | 'reasoning'>) {
  if (request.reasoning && (!request.model || !/^(gpt-5|gpt-6|o[134])/.test(request.model) || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(request.reasoning))) throw new ExecutionError('unsupported Codex model/reasoning combination');
}
