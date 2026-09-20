import type { ExecutionConfig, ExecutionSettings, ResolvedExecutionSettings, ProjectConfigDevflowYaml } from '../types/generated/index.js';

export interface ExecutionSettingsSource {
  project?(workdir: string): Promise<ProjectConfigDevflowYaml | undefined>;
  read(workdir?: string): Promise<{ global?: ExecutionConfig; project?: ExecutionConfig }>;
}
export interface SettingsSelection {
  role: keyof NonNullable<ExecutionConfig['roles']>;
  taskType?: string;
  step?: ExecutionSettings;
  explicit?: ExecutionSettings;
}
export type SettingsResolution = ResolvedExecutionSettings;
