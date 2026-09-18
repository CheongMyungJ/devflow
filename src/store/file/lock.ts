// Task 별 lock (docs/design/store.md 2.2).
// 원칙: 살아 있는 프로세스의 lock 은 절대 빼앗지 않는다. 틀릴 때는 "조용히 깨지는" 쪽이 아니라 "시끄럽게 잠기는" 쪽으로 틀린다.

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { StoreBusyError, StoreUnavailableError } from '../errors.js';
import { codeOf, type FileOps, retryTransient, sleep } from './fs-ops.js';

interface Owner {
  pid: number;
  hostname: string;
  platform: string;
  token: string;
  acquiredAt: string;
}

type Inspection = { state: 'gone' } | { state: 'unreadable' } | { state: 'owned'; owner: Owner };

export interface LockOptions {
  timeoutMs: number;
  /** 해제·회수의 rename/삭제가 일시적 오류를 만났을 때 재시도하는 총 시간. */
  transientRetryMs: number;
}

export interface Lock {
  readonly token: string;
  release(): Promise<void>;
}

/** 이미 있는 디렉터리 위로의 rename 이 실패했을 때의 오류 코드 (Windows: EPERM, POSIX: ENOTEMPTY/EEXIST). */
const OCCUPIED = new Set(['EPERM', 'EEXIST', 'ENOTEMPTY', 'EACCES', 'EBUSY']);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 은 "있지만 신호를 보낼 권한이 없다" 이므로 살아 있는 것이다.
    return codeOf(error) !== 'ESRCH';
  }
}

export class LockManager {
  /** 해제에 실패해 경로에 남아 있는 이 프로세스의 lock. 다음 획득 때 자신의 것으로 알아보고 정리한다. */
  private readonly unreleased = new Set<string>();
  private swept = false;

  constructor(
    private readonly ops: FileOps,
    private readonly locksDir: string,
    private readonly options: LockOptions,
  ) {}

  async acquire(taskId: string): Promise<Lock> {
    await this.ops.mkdir(this.locksDir, true);
    await this.sweepOnce();

    const lockPath = join(this.locksDir, `${taskId}.lock`);
    const token = randomBytes(12).toString('hex');
    const prepared = await this.prepare(token);
    const deadline = Date.now() + this.options.timeoutMs;
    let last: Inspection = { state: 'gone' };

    try {
      for (;;) {
        if (await this.tryRenameInto(prepared, lockPath)) {
          return { token, release: () => this.release(lockPath, token) };
        }
        last = await this.inspect(lockPath);
        if (last.state === 'owned') {
          if (this.unreleased.has(last.owner.token)) {
            await this.removeLock(lockPath, last.owner.token).catch(() => undefined);
            continue;
          }
          if (this.isStale(last.owner)) {
            await this.reap(taskId, lockPath, last.owner.token);
            continue;
          }
        }
        if (Date.now() >= deadline) break;
        // 'gone' 은 방금 해제된 것이므로 거의 바로 다시 시도한다.
        await sleep(last.state === 'gone' ? 1 : 10 + Math.random() * 40);
      }
    } catch (error) {
      await this.ops.remove(prepared).catch(() => undefined);
      throw error instanceof StoreBusyError ? error : new StoreUnavailableError(`cannot acquire lock for ${taskId}`, { cause: error });
    }

    await this.ops.remove(prepared).catch(() => undefined);
    throw new StoreBusyError(taskId, await this.describe(taskId, lockPath, last));
  }

  /** owner.json 이 든 디렉터리를 미리 만들어 둔다. lock 은 항상 owner.json 과 함께 나타난다. */
  private async prepare(token: string): Promise<string> {
    const dir = join(this.locksDir, `.tmp-${token}`);
    const owner: Owner = { pid: process.pid, hostname: hostname(), platform: process.platform, token, acquiredAt: new Date().toISOString() };
    await this.ops.mkdir(dir, false);
    await this.ops.writeFile(join(dir, 'owner.json'), JSON.stringify(owner));
    return dir;
  }

  private async tryRenameInto(prepared: string, target: string): Promise<boolean> {
    try {
      await this.ops.rename(prepared, target);
      return true;
    } catch (error) {
      if (OCCUPIED.has(codeOf(error) ?? '')) return false;
      throw error;
    }
  }

  private async inspect(lockPath: string): Promise<Inspection> {
    let raw: Buffer;
    try {
      raw = await this.ops.readFile(join(lockPath, 'owner.json'));
    } catch (error) {
      // lock 디렉터리째 사라졌으면 방금 해제된 것이다. 그 밖에는 읽을 수 없는 상태로 본다(빼앗지 않는다).
      if (codeOf(error) === 'ENOENT' && (await this.ops.readdir(lockPath)).length === 0) return { state: 'gone' };
      return { state: 'unreadable' };
    }
    try {
      const owner = JSON.parse(raw.toString('utf8')) as Owner;
      if (typeof owner.pid === 'number' && typeof owner.token === 'string') return { state: 'owned', owner };
    } catch {
      // 아래에서 unreadable 로 처리한다.
    }
    return { state: 'unreadable' };
  }

  private isStale(owner: Owner): boolean {
    return owner.hostname === hostname() && owner.platform === process.platform && !pidAlive(owner.pid);
  }

  /** stale lock 을 없앤다. 회수 전용 lock 을 쥔 상태에서 token 을 다시 확인한 뒤에만 없앤다. */
  private async reap(taskId: string, lockPath: string, observedToken: string): Promise<void> {
    const reapPath = join(this.locksDir, `${taskId}.reap`);
    const token = randomBytes(12).toString('hex');
    const prepared = await this.prepare(token);
    if (!(await this.tryRenameInto(prepared, reapPath))) {
      // 다른 프로세스가 회수 중이거나 회수 도중 죽어 .reap 이 남았다. 자동으로 풀지 않는다.
      await this.ops.remove(prepared).catch(() => undefined);
      await sleep(10 + Math.random() * 40);
      return;
    }
    try {
      const now = await this.inspect(lockPath);
      if (now.state === 'owned' && now.owner.token === observedToken && this.isStale(now.owner)) {
        await this.removeLock(lockPath, observedToken);
      }
    } finally {
      await this.removeLock(reapPath, token).catch(() => undefined);
    }
  }

  /** 경로에서 바로 지우지 않는다. 고유한 이름으로 옮긴 뒤 지워 "빈 lock 디렉터리" 가 보이는 순간을 없앤다. */
  private async removeLock(path: string, token: string): Promise<void> {
    const away = join(this.locksDir, `.tmp-${token}-released-${randomBytes(4).toString('hex')}`);
    await retryTransient(this.options.transientRetryMs, () => this.ops.rename(path, away));
    await this.ops.remove(away).catch(() => undefined);
  }

  private async release(lockPath: string, token: string): Promise<void> {
    try {
      await this.removeLock(lockPath, token);
      this.unreleased.delete(token);
    } catch {
      // 해제하지 못했다. 이 프로세스가 사는 동안에는 stale 이 되지 않으므로 기억해 두었다가 다음 획득 때 정리한다.
      this.unreleased.add(token);
    }
  }

  /** 죽은 프로세스가 남긴 준비용·해제용 찌꺼기를 프로세스당 한 번 치운다. */
  private async sweepOnce(): Promise<void> {
    if (this.swept) return;
    this.swept = true;
    for (const name of await this.ops.readdir(this.locksDir)) {
      if (!name.startsWith('.tmp-')) continue;
      const dir = join(this.locksDir, name);
      const found = await this.inspect(dir);
      if (found.state === 'owned' && !this.isStale(found.owner)) continue;
      if (found.state === 'unreadable') continue;
      await this.ops.remove(dir).catch(() => undefined);
    }
  }

  private async describe(taskId: string, lockPath: string, last: Inspection): Promise<string> {
    const holder = last.state === 'owned' ? `pid ${last.owner.pid} 가 ${last.owner.acquiredAt} 부터 쥐고 있다` : 'lock 의 소유자 정보를 읽을 수 없다';
    const reapLeft = (await this.ops.readdir(join(this.locksDir, `${taskId}.reap`))).length > 0;
    const targets = [lockPath, ...(reapLeft ? [join(this.locksDir, `${taskId}.reap`)] : [])].join(', ');
    return `${holder}. 다른 devflow 프로세스가 실행 중이 아닌 것을 확인한 뒤 다음을 삭제하면 풀린다: ${targets}`;
  }
}
