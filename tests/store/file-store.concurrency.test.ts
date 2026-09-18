import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StoreBusyError } from '../../src/store/errors.js';
import { nodeFileOps } from '../../src/store/file/index.js';
import { createSample, ioError, newStore, noteEvent, opsWith, spawnChild, tempDataDir } from './helpers.js';

const PROCESSES = 6;

/** 자식들이 모두 준비된 뒤 barrier 파일을 만들어 한꺼번에 출발시킨다. 경합이 실제로 일어나게 하기 위해서다. */
async function releaseTogether<T extends { waitFor(line: string): Promise<void> }>(children: T[], barrier: string): Promise<void> {
  await Promise.all(children.map((child) => child.waitFor('ready')));
  writeFileSync(barrier, '');
}

describe('FileStore: 여러 프로세스의 동시 접근', () => {
  it('같은 Task 에 동시에 commit 해도 seq 에 중복이나 빈틈이 없다 (AC3)', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const barrier = join(dataDir, 'go');
    const perProcess = 15;

    const children = Array.from({ length: PROCESSES }, (_, i) =>
      spawnChild({ dataDir, action: 'commit', taskId: task.id, count: perProcess, label: `p${i}`, barrier }),
    );
    await releaseTogether(children, barrier);
    const results = await Promise.all(children.map((child) => child.exit));
    for (const result of results) expect(result.code, result.stderr).toBe(0);

    // readEvents 는 seq 가 1부터 빈틈없이 증가하지 않으면 오류를 던진다
    const events = await store.readEvents(task.id);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 1 + PROCESSES * perProcess }, (_, i) => i + 1));

    // 모든 프로세스의 모든 이벤트가 정확히 한 번씩, 프로세스 안에서는 보낸 순서대로 들어 있다
    const notes = events.slice(1).map((e) => (e.data as { note: string }).note);
    expect(new Set(notes).size).toBe(PROCESSES * perProcess);
    for (let p = 0; p < PROCESSES; p++) {
      const mine = notes.filter((n) => n.startsWith(`p${p}-`));
      expect(mine).toEqual(Array.from({ length: perProcess }, (_, i) => `p${p}-${i}`));
    }
    // 실제로 경합했는지: 프로세스들의 이벤트가 섞여 있어야 한다(한 프로세스가 끝난 뒤 다음이 시작한 것이 아니다)
    const switches = notes.filter((n, i) => i > 0 && n.split('-')[0] !== notes[i - 1]!.split('-')[0]).length;
    expect(switches).toBeGreaterThan(PROCESSES);
  });

  it('동시에 createTask 해도 ID 가 겹치지 않는다 (AC4)', async () => {
    const dataDir = tempDataDir();
    const barrier = join(dataDir, 'go');
    const perProcess = 8;

    const children = Array.from({ length: PROCESSES }, (_, i) => spawnChild({ dataDir, action: 'create', count: perProcess, label: `p${i}`, barrier }));
    await releaseTogether(children, barrier);
    const results = await Promise.all(children.map((child) => child.exit));
    for (const result of results) expect(result.code, result.stderr).toBe(0);

    const issued = results.flatMap((r) => JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('ids '))!.slice(4)) as string[]);
    expect(issued.length).toBe(PROCESSES * perProcess);
    expect(new Set(issued).size).toBe(issued.length);

    const listed = await newStore(dataDir).list('task', {});
    expect(listed.invalid).toEqual([]);
    expect(listed.items.map((t) => t.id).sort()).toEqual([...issued].sort());
    // 각 Task 는 자신을 만든 프로세스가 쓴 내용 그대로다(서로의 쓰기가 섞이지 않았다)
    for (const task of listed.items) expect(task.target.task_branch).toBe(`task/${task.id}`);
  });

  it('같은 프로세스 안의 동시 commit 도 직렬화된다', async () => {
    const store = newStore(tempDataDir());
    const task = await createSample(store);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.commit(task.id, { events: [noteEvent(`n${i}`)] })));
    expect((await store.readEvents(task.id)).length).toBe(21);
  });
});

describe('FileStore: lock (store.md 2.2)', () => {
  it('살아 있는 프로세스의 lock 은 빼앗지 않는다 — 제한 시간 뒤 안내와 함께 StoreBusyError', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const holder = spawnChild({ dataDir, action: 'commit', taskId: task.id, count: 1, label: 'holder', holdMs: 6000 });
    await holder.waitFor('holding');

    const impatient = newStore(dataDir, { lockTimeoutMs: 300 });
    const error = await impatient.commit(task.id, { events: [noteEvent('blocked')] }).catch((e) => e);
    expect(error).toBeInstanceOf(StoreBusyError);
    expect(error.detail).toContain(`pid ${holder.process.pid}`);
    expect(error.detail).toContain(`${task.id}.lock`);
    // 진행 중인 commit 이 있으면 읽기도 그것이 끝나기를 기다린다(2.7). 제한 시간을 넘기면 같은 오류다.
    // 정상적인 commit 은 밀리초 단위라 실제로는 기다림이 보이지 않는다
    await expect(impatient.readEvents(task.id)).rejects.toBeInstanceOf(StoreBusyError);

    // holder 가 끝나면 그대로 성립한다. 빼앗기지 않았다는 뜻이다
    expect((await holder.exit).code).toBe(0);
    const notes = (await impatient.readEvents(task.id)).map((e) => (e.data as { note?: string } | undefined)?.note);
    expect(notes).toEqual([undefined, 'holder-0']);
  });

  it('lock 해제에 실패해도 같은 프로세스의 다음 접근이 자신의 lock 을 알아보고 정리한다', async () => {
    const dataDir = tempDataDir();
    let blockRelease = true; // 다른 프로그램이 lock 디렉터리를 잠깐 붙들고 있는 상황
    const ops = opsWith({ rename: async (from, to) => (blockRelease && from.endsWith('.lock') ? Promise.reject(ioError('EBUSY')) : nodeFileOps.rename(from, to)) });
    const store = newStore(dataDir, { ops, lockTimeoutMs: 2000 });
    const task = await createSample(store); // 성공하지만 lock 은 경로에 남는다
    expect(existsSync(join(dataDir, '.locks', `${task.id}.lock`))).toBe(true);

    blockRelease = false;
    // 자신의 pid 는 살아 있으므로 stale 로 회수되지 않는다. 기억해 둔 token 으로 알아보지 못하면 StoreBusyError 가 된다
    expect((await store.commit(task.id, { events: [noteEvent('next')] })).events[0]!.seq).toBe(2);
    expect(existsSync(join(dataDir, '.locks', `${task.id}.lock`))).toBe(false);
  });

  it('죽은 프로세스가 남긴 lock 은 회수된다. 여러 프로세스가 동시에 회수를 시도해도 seq 는 온전하다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const crashed = await spawnChild({ dataDir, action: 'update', taskId: task.id, title: 'x', crashAt: 'after-pending' }).exit;
    expect(crashed.code).toBe(9);

    const barrier = join(dataDir, 'go');
    const children = Array.from({ length: PROCESSES }, (_, i) => spawnChild({ dataDir, action: 'commit', taskId: task.id, count: 3, label: `p${i}`, barrier }));
    await releaseTogether(children, barrier);
    for (const result of await Promise.all(children.map((child) => child.exit))) expect(result.code, result.stderr).toBe(0);

    expect((await store.readEvents(task.id)).length).toBe(1 + PROCESSES * 3);
  });
});
