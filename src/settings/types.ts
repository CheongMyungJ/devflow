import type { ExecutionConfig, ExecutionSettings, ResolvedExecutionSettings, Run } from '../types/generated/index.js';

export interface ExecutionSettingsSource {
  read(workdir?: string): Promise<{ global?: ExecutionConfig; project?: ExecutionConfig }>;
}
export interface SettingsSelection {
  role: Run['role'];
  taskType?: string;
  step?: ExecutionSettings;
  explicit?: ExecutionSettings;
}
export type SettingsResolution = ResolvedExecutionSettings;
