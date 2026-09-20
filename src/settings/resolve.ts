import { loadSchemas } from '../schema/registry.mjs';
import type { ExecutionConfig, ExecutionSettings } from '../types/generated/index.js';
import type { SettingsResolution, SettingsSelection } from './types.js';

const schemas = loadSchemas();
export function resolveExecutionSettings(configs: { global?: ExecutionConfig; project?: ExecutionConfig }, selection: SettingsSelection): SettingsResolution {
  const values: ExecutionSettings = {};
  const sources: SettingsResolution['sources'] = {};
  const question = selection.role === 'question';
  const apply = (layer: ExecutionSettings | undefined, source: SettingsResolution['sources'][string]) => {
    if (!layer) return;
    // Common defaults also serve managed roles. Only AI selection is inherited by
    // an independent question; question-specific layers reject lifecycle controls.
    if (question && source.endsWith('.defaults')) layer = Object.fromEntries(Object.entries(layer).filter(([key]) => ['backend', 'model', 'reasoning'].includes(key)));
    if (!schemas.validator(question ? 'question-settings' : 'execution-settings')(layer)) throw new Error(`Invalid execution settings: ${source}`);
    if (layer.backend !== undefined && layer.backend !== values.backend) {
      delete values.model; delete values.reasoning; delete sources.model; delete sources.reasoning;
    }
    Object.assign(values, layer);
    for (const field of Object.keys(layer)) sources[field] = source;
  };
  apply(question ? { backend: 'codex' } : { backend: 'fake', isolation: 'project', output_retries: 0 }, 'product');
  for (const level of ['global', 'project'] as const) {
    const config = configs[level];
    if (!config) continue;
    if (!schemas.validator('execution-config')(config)) throw new Error(`Invalid ${level} execution configuration`);
    apply(config.defaults, `${level}.defaults`);
    apply(config.roles?.[selection.role], `${level}.role`);
    if (selection.taskType) apply(config.task_types?.[selection.taskType]?.[selection.role], `${level}.task_type`);
  }
  apply(selection.step, 'step'); apply(selection.explicit, 'explicit');
  return { values, sources };
}
