import type { Task, WorkspacePreparation } from '../types/generated/index.js';

export interface BaseBranchResolver {
  defaultBranch(repo: string): Promise<string>;
}

/** 로컬 위치는 실행 결과에만 존재한다. Store에 이 객체를 기록하지 않는다. */
export interface WorkspaceLocation {
  workdir: string;
  head: string;
  dirty: boolean;
}

export type WorkspaceInspection =
  | { state: 'missing' }
  | { state: 'ready'; location: WorkspaceLocation }
  | { state: 'blocked'; reason: string };

export interface Workspace extends BaseBranchResolver {
  /** Read immutable Git objects, never the moving worktree. No paths leave this adapter. */
  snapshot?(repo: string, sha: string): Promise<Array<{ path: string; base64: string }>>;
  /** 충돌을 확인하고 기준 branch를 SHA로 해석한다. 원격이면 반드시 fetch한다. */
  resolveBase(task: Task): Promise<string>;
  /** 해당 요청의 작업공간을 준비한다. 겹친 실행은 기다리지 않고 오류로 돌려준다. */
  ensure(preparation: WorkspacePreparation): Promise<WorkspaceLocation>;
  /** 조회는 Git/로컬 관리 기록을 변경하지 않는다. */
  inspect(preparation: WorkspacePreparation): Promise<WorkspaceInspection>;
}
