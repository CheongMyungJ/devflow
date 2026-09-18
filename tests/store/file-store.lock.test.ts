// lock 의 드문 경로 (store.md 2.2, 2.8). Gate G-004 가 찾은 결함의 회귀 테스트를 포함한다.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaViolationError, StoreBusyError, StoreError, StoreUnavailableError } from '../../src/store/errors.js';
import { nodeFileOps } from '../../src/store/file/index.js';
import { createSample, ioError, newStore, noteEvent, opsWith, tempDataDir } from './helpers.js';

/** 이미 끝난 프로세스의 pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

function plantLock(dataDir: string, name: string, owner: { pid: number; hostname?: string; platform?: string }): string {
  const dir = join(dataDir, '.locks', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'owner.json'),
    JSON.stringify({ hostname: hostname(), platform: process.platform, token: `planted-${name}`, acquiredAt: '2026-01-01T00:00:00Z', ...owner }),
  );
  return dir;
}

/** 제한 시간의 몇 배 안에 끝나는지 확인한다. 끝나지 않는 acquire 를 테스트 시간 초과가 아니라 단언으로 잡는다. */
async function settlesWithin<T>(ms: number, promise: Promise<T>): Promise<T | 'hung'> {
  return Promise.race([promise, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))]);
}

describe('lock: 사람이 풀어야 하는 상황은 제한 시간 안에 안내와 함께 끝난다', () => {
  it('죽은 소유자의 lock 과 죽은 회수자의 .reap 이 함께 남음 → StoreBusyError, 둘 다 지우라고 안내한다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const pid = await deadPid();
    const lockDir = plantLock(dataDir, `${task.id}.lock`, { pid });
    const reapDir = plantLock(dataDir, `${task.id}.reap`, { pid });

    const store = newStore(dataDir, { lockTimeoutMs: 300 });
    const outcome = await settlesWithin(3000, store.commit(task.id, { events: [noteEvent('x')] }).catch((e) => e));
    expect(outcome).not.toBe('hung');
    expect(outcome).toBeInstanceOf(StoreBusyError);
    expect((outcome as StoreBusyError).detail).toContain(`${task.id}.lock`);
    expect((outcome as StoreBusyError).detail).toContain(`${task.id}.reap`);
    // .reap 은 자동으로 풀지 않는다
    expect(existsSync(lockDir) && existsSync(reapDir)).toBe(true);

    // 사람이 안내대로 .reap 을 지우면 stale lock 은 회수되고 진행된다
    await nodeFileOps.remove(reapDir);
    expect((await store.commit(task.id, { events: [noteEvent('after')] })).events[0]!.seq).toBe(2);
  });

  it('자신의 lock 을 끝내 해제하지 못함 → 다음 접근은 멈추지 않고 StoreBusyError', async () => {
    const dataDir = tempDataDir();
    const ops = opsWith({ rename: async (from, to) => (from.endsWith('.lock') ? Promise.reject(ioError('EBUSY')) : nodeFileOps.rename(from, to)) });
    const store = newStore(dataDir, { ops, lockTimeoutMs: 300 });
    const task = await createSample(store); // 성공하지만 lock 이 남는다

    const outcome = await settlesWithin(3000, store.commit(task.id, { events: [noteEvent('x')] }).catch((e) => e));
    expect(outcome).not.toBe('hung');
    expect(outcome).toBeInstanceOf(StoreBusyError);
  });

  it('다른 호스트·다른 플랫폼의 lock 은 소유자가 죽었는지 판정할 수 없으므로 빼앗지 않는다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const pid = await deadPid();
    const store = newStore(dataDir, { lockTimeoutMs: 200 });

    for (const foreign of [{ hostname: 'some-other-host' }, { platform: process.platform === 'win32' ? 'linux' : 'win32' }]) {
      const lockDir = plantLock(dataDir, `${task.id}.lock`, { pid, ...foreign });
      await expect(store.commit(task.id, { events: [noteEvent('x')] })).rejects.toBeInstanceOf(StoreBusyError);
      expect(existsSync(lockDir)).toBe(true);
      await nodeFileOps.remove(lockDir);
    }
    // 같은 호스트·플랫폼의 죽은 pid 는 회수된다 (대조군)
    plantLock(dataDir, `${task.id}.lock`, { pid });
    expect((await store.commit(task.id, { events: [noteEvent('ok')] })).events[0]!.seq).toBe(2);
  });

  it('소유자 정보를 읽을 수 없는 lock 은 빼앗지 않는다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const lockDir = join(dataDir, '.locks', `${task.id}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), '{ not json');

    const error = await newStore(dataDir, { lockTimeoutMs: 200 }).commit(task.id, { events: [noteEvent('x')] }).catch((e) => e);
    expect(error).toBeInstanceOf(StoreBusyError);
    expect(error.detail).toContain('읽을 수 없다');
    expect(existsSync(lockDir)).toBe(true);
  });
});

describe('lock: 저장소 접근 실패는 StoreUnavailableError 로 나온다', () => {
  it('lock 을 만들 수 없는 매체(읽기 전용 등) → 쓰기와 lock 경로의 읽기 모두 StoreError 다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    mkdirSync(join(dataDir, task.id, '.pending-left-behind')); // 읽기를 lock 경로로 보낸다
    const readOnly = newStore(dataDir, { ops: opsWith({ mkdir: async (path, recursive) => (path.includes('.locks') ? Promise.reject(ioError('EROFS')) : nodeFileOps.mkdir(path, recursive)) }) });

    for (const attempt of [() => readOnly.commit(task.id, { events: [noteEvent('x')] }), () => readOnly.get('task', { taskId: task.id }), () => readOnly.readEvents(task.id)]) {
      const error = await attempt().catch((e) => e);
      expect(error).toBeInstanceOf(StoreError);
      expect(error).toBeInstanceOf(StoreUnavailableError);
      expect((error.cause as { code: string }).code).toBe('EROFS');
    }
  });
});

describe('lock: 찌꺼기 청소는 죽은 것이 확인된 것만 지운다', () => {
  it('다른 프로세스가 막 준비 중인 디렉터리(owner.json 이 아직 없음)와 살아 있는 소유자의 것은 건드리지 않는다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const preparing = join(dataDir, '.locks', '.tmp-being-prepared');
    mkdirSync(preparing, { recursive: true });
    const alive = plantLock(dataDir, '.tmp-alive', { pid: process.pid });
    const dead = plantLock(dataDir, '.tmp-dead', { pid: await deadPid() });

    await newStore(dataDir).commit(task.id, { events: [noteEvent('x')] }); // 새 프로세스의 첫 획득에 해당한다

    expect(existsSync(preparing)).toBe(true);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });
});

describe('손상된 로그 위에 commit 을 쌓지 않는다', () => {
  it('줄 수와 마지막 seq 가 맞지 않으면 commit 은 거부되고 디스크는 그대로다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const eventsFile = join(dataDir, task.id, 'events.jsonl');
    appendFileSync(eventsFile, `${JSON.stringify({ seq: 5, task_id: task.id, type: 'task.done', actor: 'system', at: '2026-01-01T00:00:00Z' })}\n`);

    const error = await store.commit(task.id, { events: [noteEvent('x')] }).catch((e) => e);
    expect(error).toBeInstanceOf(SchemaViolationError);
    expect(error.phase).toBe('read');
    expect(existsSync(join(dataDir, task.id, '.rollbacks'))).toBe(false);
  });
});
