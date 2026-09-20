import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Task, WorkspacePreparation } from '../../types/generated/index.js';
import { WorkspaceError } from '../errors.js';
import { isBranchName } from '../refs.js';
import type { Workspace, WorkspaceInspection, WorkspaceLocation } from '../types.js';
import { git, gitBytes } from './git.js';
import type { ProjectCatalog, ProjectLocation } from './settings.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), path.slice(parent.length).replace(/^[/\\]+/, ''));
  }
}
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

interface Layout extends ProjectLocation { common: string; workdir: string; journal: string; lock: string }
interface WorktreeEntry { path: string; branch?: string }

/** 한 호스트의 로컬 Git 구현. force/reset/prune/remove로 기존 작업을 복구하지 않는다. */
export class GitWorkspace implements Workspace {
  constructor(private readonly catalog: ProjectCatalog) {}

  async snapshot(repo: string, sha: string) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new WorkspaceError('configuration', 'Snapshot requires a full commit SHA');
    const project = await this.project(repo);
    if (await git(project.clone, ['rev-parse', '--verify', `${sha}^{commit}`]) !== sha) throw new WorkspaceError('configuration', 'Snapshot SHA must identify a commit');
    const tree = (await gitBytes(project.clone, ['ls-tree', '-r', '-z', sha])).toString('utf8').split('\0').filter(Boolean);
    const files: Array<{ path: string; base64: string }> = []; let size = 0;
    for (const entry of tree) {
      const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (!match || !['100644', '100755'].includes(match[1]!)) throw new WorkspaceError('configuration', 'Question snapshots do not support symlinks or submodules');
      const bytes = await gitBytes(project.clone, ['cat-file', 'blob', match[2]!]);
      size += bytes.length;
      if (size > 32 * 1024 * 1024 || files.length >= 10000) throw new WorkspaceError('configuration', 'Question snapshot exceeds the supported size');
      files.push({ path: match[3]!, base64: bytes.toString('base64') });
    }
    return files;
  }

  async defaultBranch(repo: string): Promise<string> {
    const url = await this.catalog.remoteUrl(repo);
    const output = await git(undefined, ['ls-remote', '--symref', '--', url, 'HEAD']);
    const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(output)?.[1];
    if (!isBranchName(branch)) throw new WorkspaceError('configuration', `프로젝트 ${repo}: 원격 HEAD의 기본 branch를 확인할 수 없다`);
    return branch;
  }

  private async project(repo: string): Promise<ProjectLocation & { common: string }> {
    const project = await this.catalog.locate(repo);
    const clone = await canonical(resolve(project.clone));
    const root = await canonical(resolve(project.worktreeRoot));
    const top = await canonical(await git(clone, ['rev-parse', '--show-toplevel']));
    if (!samePath(top, clone)) throw new WorkspaceError('configuration', 'clone 설정은 Git 작업공간 루트여야 한다');
    if (inside(clone, root) || inside(root, clone)) throw new WorkspaceError('configuration', 'worktree_root와 clone은 서로 포함할 수 없다');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project.remote)) throw new WorkspaceError('configuration', 'remote 이름이 올바르지 않다');
    const remote = await git(clone, ['config', '--get-all', `remote.${project.remote}.url`]);
    if (remote !== project.url) throw new WorkspaceError('configuration', '로컬 clone의 remote URL과 프로젝트 등록부가 다르다');
    const common = await canonical(await git(clone, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    return { ...project, clone, worktreeRoot: root, common };
  }

  private async checkBranch(clone: string, name: string): Promise<void> {
    if (!isBranchName(name)) throw new WorkspaceError('configuration', '올바른 branch 이름이 아니다');
    await git(clone, ['check-ref-format', `refs/heads/${name}`]);
  }

  private async branchSha(clone: string, branch: string): Promise<string | undefined> {
    // --verify의 실패를 모두 "없음"으로 삼지 않는다. 저장소/I/O 오류는 그대로 노출한다.
    const output = await git(clone, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${branch}`]);
    return output.split('\n').find((line) => line.startsWith(`refs/heads/${branch} `))?.split(' ')[1];
  }

  async resolveBase(task: Task): Promise<string> {
    if (!task.target.base_source) throw new WorkspaceError('configuration', '옛 Task의 base_source가 미확정이다. 원격/로컬을 명시한 새 Task가 필요하다');
    const p = await this.project(task.target.repo);
    await this.checkBranch(p.clone, task.target.base_branch);
    await this.checkBranch(p.clone, task.target.task_branch);
    if (await this.branchSha(p.clone, task.target.task_branch)) throw new WorkspaceError('conflict', 'Task branch가 이미 존재한다. 기존 branch는 자동 채택하지 않는다');
    if (task.target.base_source === 'local') return git(p.clone, ['rev-parse', '--verify', `refs/heads/${task.target.base_branch}^{commit}`]);
    // 전용 임시 ref를 사용해 다른 fetch의 FETCH_HEAD와 혼동하지 않는다. 공유 branch는 갱신하지 않는다.
    const ref = `refs/devflow/fetch/${randomUUID()}`;
    await git(p.clone, ['fetch', '--no-tags', '--no-recurse-submodules', '--', p.remote, `+refs/heads/${task.target.base_branch}:${ref}`]);
    return git(p.clone, ['rev-parse', '--verify', `${ref}^{commit}`]);
  }

  private async layout(preparation: WorkspacePreparation): Promise<Layout> {
    const p = await this.project(preparation.repo);
    await this.checkBranch(p.clone, preparation.task_branch);
    if (!/^T-[0-9]{4,}$/.test(preparation.task_id) || !/^[0-9a-f-]{36}$/.test(preparation.workspace_id)) {
      throw new WorkspaceError('configuration', 'Workspace 식별자가 올바르지 않다');
    }
    const workdir = join(p.worktreeRoot, `${preparation.task_id}-${preparation.workspace_id}`);
    const actual = await canonical(workdir);
    if (!samePath(actual, workdir)) throw new WorkspaceError('conflict', '작업공간 경로가 symlink/junction으로 바뀌었다');
    const admin = join(p.common, 'devflow-workspaces');
    return { ...p, workdir, journal: join(admin, `${digest(preparation.task_branch)}.json`), lock: join(admin, 'prepare.lock') };
  }

  private async worktrees(clone: string): Promise<WorktreeEntry[]> {
    const output = await git(clone, ['worktree', 'list', '--porcelain', '-z']);
    return output.split('\0\0').filter(Boolean).map((block) => {
      const tokens = block.split('\0');
      const path = tokens.find((s) => s.startsWith('worktree '))?.slice(9);
      if (!path) throw new WorkspaceError('manual', 'Git worktree 목록을 해석하지 못했다');
      const branch = tokens.find((s) => s.startsWith('branch '))?.slice(7);
      return { path, ...(branch ? { branch } : {}) };
    });
  }

  private async journal(p: Layout, preparation: WorkspacePreparation): Promise<boolean> {
    if (!(await exists(p.journal))) return false;
    try {
      const saved: unknown = JSON.parse(await readFile(p.journal, 'utf8'));
      if (!isDeepStrictEqual(saved, { preparation, workdir: p.workdir, url: p.url })) throw new Error('다른 준비 요청 또는 설정');
      return true;
    } catch (cause) {
      throw new WorkspaceError('manual', `작업공간 소유 기록이 다르거나 손상되었다: ${p.journal}`, { cause });
    }
  }

  private async inspectAt(p: Layout, preparation: WorkspacePreparation, verifyNew = false): Promise<WorkspaceInspection> {
    const owned = await this.journal(p, preparation);
    const trees = await this.worktrees(p.clone);
    const atPath = trees.find((tree) => samePath(resolve(tree.path), p.workdir));
    const atBranch = trees.filter((tree) => tree.branch === `refs/heads/${preparation.task_branch}`);
    const branch = await this.branchSha(p.clone, preparation.task_branch);
    if (atPath) {
      if (!owned || atPath.branch !== `refs/heads/${preparation.task_branch}` || atBranch.length !== 1 || !branch) {
        return { state: 'blocked', reason: '작업공간의 소유 요청·branch가 일치하지 않는다' };
      }
      if (!(await exists(p.workdir))) return { state: 'blocked', reason: '등록된 worktree 디렉터리가 사라졌다. 자동 재생성하지 않는다' };
      // worktree add 실패는 부분 checkout을 남길 수 있다. 이를 사용자의 수정으로 오인하지 않는다.
      if (!verifyNew && (!(await exists(`${p.journal}.ready`)) || await readFile(`${p.journal}.ready`, 'utf8') !== preparation.workspace_id)) {
        return { state: 'blocked', reason: 'Git 생성 완료 표식이 없다/다르다. 부분 checkout일 수 있어 수동 확인이 필요하다' };
      }
      const common = await canonical(await git(p.workdir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      const top = await canonical(await git(p.workdir, ['rev-parse', '--show-toplevel']));
      if (!samePath(common, p.common) || !samePath(top, p.workdir)) return { state: 'blocked', reason: '작업공간이 다른 Git 저장소를 가리킨다' };
      const head = await git(p.workdir, ['rev-parse', '--verify', 'HEAD']);
      const actualBranch = await git(p.workdir, ['symbolic-ref', '--quiet', 'HEAD']);
      if (actualBranch !== `refs/heads/${preparation.task_branch}` || head !== branch) return { state: 'blocked', reason: '작업공간의 HEAD가 Task branch와 다르다' };
      return { state: 'ready', location: { workdir: p.workdir, head, dirty: (await git(p.workdir, ['status', '--porcelain', '--untracked-files=all'])) !== '' } };
    }
    if (await exists(`${p.journal}.ready`)) return { state: 'blocked', reason: '생성 완료 표식은 있으나 worktree 등록이 없다. 자동 재생성하지 않는다' };
    if (atBranch.length || await exists(p.workdir)) return { state: 'blocked', reason: 'Task branch가 다른 worktree에 있거나 목적지가 이미 존재한다' };
    if (branch && (!owned || branch !== preparation.base_sha)) return { state: 'blocked', reason: '기존 Task branch를 안전하게 이어갈 수 없다' };
    return { state: 'missing' };
  }

  async inspect(preparation: WorkspacePreparation): Promise<WorkspaceInspection> {
    try {
      const p = await this.layout(preparation);
      if (await exists(p.lock)) return { state: 'blocked', reason: `준비 중이거나 이전 실행의 잠금이 남아 있다: ${p.lock}. 모든 관련 프로세스가 종료됐는지 확인한 뒤 사람이 잠금 파일을 제거해야 한다` };
      return await this.inspectAt(p, preparation);
    } catch (error) {
      return { state: 'blocked', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensure(preparation: WorkspacePreparation): Promise<WorkspaceLocation> {
    const p = await this.layout(preparation);
    await mkdir(dirname(p.lock), { recursive: true });
    try {
      await writeFile(p.lock, JSON.stringify({ pid: process.pid, workspace_id: preparation.workspace_id }), { flag: 'wx' });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('busy', `준비 중이거나 잠금이 남아 있다: ${p.lock}. 자동 대기·회수하지 않는다. 관련 프로세스 종료를 확인한 뒤 사람이 잠금 파일을 제거하라`);
      throw cause;
    }
    try {
      const state = await this.inspectAt(p, preparation);
      if (state.state === 'ready') return state.location;
      if (state.state === 'blocked') throw new WorkspaceError('conflict', state.reason);
      // 소유 기록은 branch/worktree보다 먼저 쓴다. 불완전한 파일은 자동 덮어쓰지 않는다.
      if (!(await this.journal(p, preparation))) await writeFile(p.journal, JSON.stringify({ preparation, workdir: p.workdir, url: p.url }), { flag: 'wx' });
      await git(p.clone, ['cat-file', '-e', `${preparation.base_sha}^{commit}`]);
      await mkdir(p.worktreeRoot, { recursive: true });
      if (!(await this.branchSha(p.clone, preparation.task_branch))) {
        await git(p.clone, ['branch', '--no-track', preparation.task_branch, preparation.base_sha]);
      }
      await git(p.clone, ['worktree', 'add', '--', p.workdir, preparation.task_branch]);
      const done = await this.inspectAt(p, preparation, true);
      if (done.state !== 'ready') throw new WorkspaceError('manual', 'Git 생성 후 작업공간 검증에 실패했다');
      await writeFile(`${p.journal}.ready`, preparation.workspace_id, { flag: 'wx' });
      return done.location;
    } finally {
      // 자신이 얻은 잠금만 제거한다. 프로세스 강제 종료 시에는 남겨 수동 확인을 요구한다.
      await unlink(p.lock);
    }
  }
}
