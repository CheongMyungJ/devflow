import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadSchemas } from '../../schema/registry.mjs';
import type { ProjectRegistry, WorkspaceMachineConfig } from '../../types/generated/index.js';
import { WorkspaceError } from '../errors.js';

export interface ProjectLocation {
  url: string;
  clone: string;
  worktreeRoot: string;
  remote: string;
}

export interface ProjectCatalog {
  remoteUrl(repo: string): Promise<string>;
  locate(repo: string): Promise<ProjectLocation>;
}

/** 공유 등록부와 머신 설정의 포맷/위치는 이 어댑터에만 있다. 읽을 때마다 검증한다. */
export class FileProjectCatalog implements ProjectCatalog {
  constructor(private readonly registryFile: string, private readonly machineFile?: string) {}

  private async read<T>(file: string, schema: string): Promise<T> {
    try {
      const value: unknown = parse(await readFile(file, 'utf8'));
      const validate = loadSchemas().validator(schema);
      if (!validate(value)) throw new Error(JSON.stringify(validate.errors));
      return value as T;
    } catch (cause) {
      throw new WorkspaceError('configuration', `${schema} 설정을 읽거나 검증하지 못했다: ${file}`, { cause });
    }
  }

  async remoteUrl(repo: string): Promise<string> {
    const registry = await this.read<ProjectRegistry>(this.registryFile, 'project-registry');
    const url = Object.hasOwn(registry.projects, repo) ? registry.projects[repo]?.repo : undefined;
    // 실제 공유 설정에는 머신 경로를 넣지 않는다. 테스트의 로컬 원격은 ProjectCatalog 대역을 사용한다.
    if (!url || !(/^(https?|ssh|git):\/\//.test(url) || /^[^\s/@:]+@[^\s/:]+:.+/.test(url))) {
      throw new WorkspaceError('configuration', `프로젝트 ${repo}: 등록된 원격 URL이 필요하다 (로컬 경로는 받지 않는다)`);
    }
    return url;
  }

  async locate(repo: string): Promise<ProjectLocation> {
    const url = await this.remoteUrl(repo);
    if (!this.machineFile) throw new WorkspaceError('configuration', '--machine-config 또는 DEVFLOW_MACHINE_CONFIG가 필요하다');
    const machine = await this.read<WorkspaceMachineConfig>(this.machineFile, 'workspace-machine-config');
    const entry = Object.hasOwn(machine.projects, repo) ? machine.projects[repo] : undefined;
    if (!entry) throw new WorkspaceError('configuration', `프로젝트 ${repo}: 머신의 clone·worktree_root 설정이 없다`);
    return { url, clone: resolve(dirname(this.machineFile), entry.clone), worktreeRoot: resolve(dirname(this.machineFile), entry.worktree_root), remote: entry.remote ?? 'origin' };
  }
}
