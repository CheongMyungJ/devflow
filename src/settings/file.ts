import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadSchemas } from '../schema/registry.mjs';
import type { ExecutionConfig, ProjectConfigDevflowYaml } from '../types/generated/index.js';
import type { ExecutionSettingsSource } from './types.js';

const schemas = loadSchemas();
export class FileExecutionSettings implements ExecutionSettingsSource {
  constructor(private readonly globalPath?: string, private readonly projectPath?: string) {}
  private async readFile(path: string, schema: string, optional: boolean): Promise<unknown> {
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const value: unknown = parse(text);
    if (!schemas.validator(schema)(value)) throw new Error(`Invalid ${schema} configuration: ${path}`);
    return value;
  }
  async read(workdir?: string) {
    const global = this.globalPath ? await this.readFile(this.globalPath, 'execution-config', false) as ExecutionConfig : undefined;
    const path = this.projectPath ?? (workdir ? join(workdir, '.devflow.yaml') : undefined);
    const project = path ? await this.readFile(path, 'project-config', !this.projectPath) as ProjectConfigDevflowYaml | undefined : undefined;
    return { ...(global ? { global } : {}), ...(project?.execution ? { project: project.execution } : {}) };
  }
  async project(workdir: string) {
    return await this.readFile(this.projectPath ?? join(workdir, '.devflow.yaml'), 'project-config', !this.projectPath) as ProjectConfigDevflowYaml | undefined;
  }
}
