// store.md 2.4 의 단계별 실패 표와 2.5 의 복구 판정표를 행마다 재현한다.
// crash 는 실제 자식 프로세스를 그 지점에서 종료시켜 만들고(lock 과 .pending 이 남는다), I/O 오류는 FileOps 를 감싸 주입한다.
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommitOutcomeUnknownError, SchemaViolationError, StoreUnavailableError } from '../../src/store/errors.js';
import { nodeFileOps } from '../../src/store/file/index.js';
import { type CrashPoint, createSample, ioError, newStore, noteEvent, opsWith, readText, snapshot, spawnChild, tempDataDir } from './helpers.js';

const pendingDirs = (dataDir: string, taskId: string) => readdirSync(join(dataDir, taskId)).filter((n) => n.startsWith('.pending-'));
const isEvents = (p: string) => p.endsWith('events.jsonl');

async function crashDuringUpdate(dataDir: string, taskId: string, crashAt: CrashPoint) {
  const result = await spawnChild({ dataDir, action: 'update', taskId, title: 'updated-by-crashed-process', crashAt }).exit;
  expect(result.code, result.stderr).toBe(9);
}

describe('프로세스가 commit 도중 죽었을 때 (2.5 의 복구 판정표)', () => {
  it('메모(commit.json)를 쓰기 전에 죽음 → 버린다. 기록된 것이 없다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    await crashDuringUpdate(dataDir, task.id, 'during-pending');
    expect(pendingDirs(dataDir, task.id).length).toBe(1);
    expect(existsSync(join(dataDir, task.id, pendingDirs(dataDir, task.id)[0]!, 'commit.json'))).toBe(false);

    // 읽기만으로도 정리된다(표식이 .pending 을 보고 lock 경로로 간다)
    expect((await store.get('task', { taskId: task.id }))?.title).toBe('sample');
    expect(pendingDirs(dataDir, task.id)).toEqual([]);
    expect((await store.commit(task.id, { events: [noteEvent('next')] })).events[0]!.seq).toBe(2);
  });

  it('메모를 쓴 뒤 append 전에 죽음 → 되돌린다(꼬리가 비어 있다)', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    await crashDuringUpdate(dataDir, task.id, 'after-pending');

    expect((await store.readEvents(task.id)).length).toBe(1);
    expect((await store.get('task', { taskId: task.id }))?.title).toBe('sample');
    expect(pendingDirs(dataDir, task.id)).toEqual([]);
  });

  it('append 도중 죽음(잘린 줄) → 자신이 쓴 바이트만 잘라내고 되돌린다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    await store.commit(task.id, { events: [noteEvent('kept')] });
    const before = readText(join(dataDir, task.id, 'events.jsonl'));
    await crashDuringUpdate(dataDir, task.id, 'torn-append');
    const torn = readText(join(dataDir, task.id, 'events.jsonl'));
    expect(torn.length).toBeGreaterThan(before.length);
    expect(torn.endsWith('\n')).toBe(false);

    expect((await store.readEvents(task.id)).map((e) => e.seq)).toEqual([1, 2]);
    expect(readText(join(dataDir, task.id, 'events.jsonl'))).toBe(before);
    expect((await store.get('task', { taskId: task.id }))?.title).toBe('sample');
    expect(readText(join(dataDir, task.id, '.rollbacks')).length).toBe(1); // 되돌리기마다 1바이트
    expect((await store.commit(task.id, { events: [noteEvent('next')] })).events[0]!.seq).toBe(3);
  });

  it('이벤트 2개 중 첫 줄만 온전히 기록하고 죽음 → 성립하지 않았다. 온전한 첫 줄까지 되돌린다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const before = readText(join(dataDir, task.id, 'events.jsonl'));
    await crashDuringUpdate(dataDir, task.id, 'partial-append');
    const partial = readText(join(dataDir, task.id, 'events.jsonl'));
    expect(partial.endsWith('\n')).toBe(true); // 잘린 줄은 없다. 온전한 seq 2 가 있고 seq 3 이 없을 뿐이다
    expect(partial.trim().split('\n').length).toBe(2);

    // 한 commit 의 이벤트는 전부 보이거나 전혀 보이지 않는다
    expect((await store.readEvents(task.id)).map((e) => e.seq)).toEqual([1]);
    expect(readText(join(dataDir, task.id, 'events.jsonl'))).toBe(before);
    expect((await store.get('task', { taskId: task.id }))?.title).toBe('sample');
  });

  it('append 뒤 뒷정리 전에 죽음 → 앞으로 굴린다. 이벤트와 엔티티가 함께 보인다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    await crashDuringUpdate(dataDir, task.id, 'after-append');
    expect(readText(join(dataDir, task.id, 'task.yaml'))).toContain('title: sample'); // 아직 옛 내용

    expect((await store.get('task', { taskId: task.id }))?.title).toBe('updated-by-crashed-process');
    expect((await store.readEvents(task.id)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(pendingDirs(dataDir, task.id)).toEqual([]);
    expect(existsSync(join(dataDir, task.id, '.rollbacks'))).toBe(false);
  });

  it('createTask 도중(첫 append 에서) 죽음 → 그 ID 는 버려지고 Task 는 존재하지 않는다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    await createSample(store);
    const crashed = await spawnChild({ dataDir, action: 'create', count: 1, label: 'x', crashAt: 'torn-append' }).exit;
    expect(crashed.code).toBe(9);

    expect((await store.list('task', {})).items.map((t) => t.id)).toEqual(['T-0001']);
    expect(await store.get('task', { taskId: 'T-0002' })).toBeUndefined();
    expect((await createSample(store)).id).toBe('T-0003');
  });

  it('예상 밖의 상태 → 판정하지 않는다. 아무것도 건드리지 않고 오류로 드러낸다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    await crashDuringUpdate(dataDir, task.id, 'after-pending');
    // 메모에 적힌 것과 다른 내용이 그 자리에 있다 (lock 의 가정이 깨졌거나 사람이 파일을 고친 경우)
    appendFileSync(join(dataDir, task.id, 'events.jsonl'), `${JSON.stringify({ seq: 2, task_id: task.id, type: 'task.done', actor: 'system', at: '2026-01-01T00:00:00Z' })}\n`);
    const before = snapshot(dataDir);

    for (const attempt of [() => store.commit(task.id, { events: [noteEvent('x')] }), () => store.get('task', { taskId: task.id }), () => store.readEvents(task.id)]) {
      const error = await attempt().catch((e) => e);
      expect(error).toBeInstanceOf(SchemaViolationError);
      expect(error.phase).toBe('read');
      expect(error.message).toContain('자동으로 복구하지 않는다');
    }
    expect(snapshot(dataDir)).toEqual(before);

    // .pending 이 둘 이상인 경우도 같다
    mkdirSync(join(dataDir, task.id, '.pending-second'));
    await expect(store.commit(task.id, { events: [noteEvent('x')] })).rejects.toBeInstanceOf(SchemaViolationError);
  });

  it('복구는 여러 번 해도 결과가 같다 — 앞으로 굴리던 중 다시 죽어도 된다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    await crashDuringUpdate(dataDir, task.id, 'after-append');
    // 첫 복구 시도: rename 이 계속 실패해 끝내지 못한다
    const stuck = newStore(dataDir, { ops: opsWith({ rename: async (from, to) => (from.endsWith('.tmp') ? Promise.reject(ioError('EBUSY')) : nodeFileOps.rename(from, to)) }) });
    expect((await stuck.get('task', { taskId: task.id }))?.title).toBe('updated-by-crashed-process'); // tmp 의 내용을 읽어 돌려준다
    expect(pendingDirs(dataDir, task.id).length).toBe(1);
    // 두 번째 복구 시도가 마저 끝낸다
    const healthy = newStore(dataDir);
    expect((await healthy.commit(task.id, { events: [noteEvent('next')] })).events[0]!.seq).toBe(4);
    expect(pendingDirs(dataDir, task.id)).toEqual([]);
    expect(readText(join(dataDir, task.id, 'task.yaml'))).toContain('updated-by-crashed-process');
  });
});

describe('I/O 오류가 났을 때 commit() 의 결과 (2.4 의 단계별 실패 표)', () => {
  it('5단계(메모 쓰기) 실패 → StoreUnavailableError, 기록된 것이 없다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const before = snapshot(dataDir);
    const store = newStore(dataDir, { ops: opsWith({ writeFile: async (p, d) => (p.endsWith('commit.json') ? Promise.reject(ioError('ENOSPC')) : nodeFileOps.writeFile(p, d)) }) });

    const error = await store.commit(task.id, { writes: [{ kind: 'task', value: { ...task, title: 'never' } }], events: [noteEvent('never')] }).catch((e) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect((error.cause as { code: string }).code).toBe('ENOSPC');
    expect(snapshot(dataDir)).toEqual(before);
  });

  it('6단계(append) 실패, 아무것도 쓰이지 않음 → 되돌리고 StoreUnavailableError', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const store = newStore(dataDir, { ops: opsWith({ append: async (p, d) => (isEvents(p) ? Promise.reject(ioError('EIO')) : nodeFileOps.append(p, d)) }) });

    await expect(store.commit(task.id, { events: [noteEvent('never')] })).rejects.toBeInstanceOf(StoreUnavailableError);
    expect((await newStore(dataDir).readEvents(task.id)).length).toBe(1);
    expect(pendingDirs(dataDir, task.id)).toEqual([]);
  });

  it('6단계 실패, 일부만 쓰임 → 되돌리고 StoreUnavailableError', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const store = newStore(dataDir, {
      ops: opsWith({
        append: async (p, d) => {
          if (!isEvents(p)) return nodeFileOps.append(p, d);
          await nodeFileOps.append(p, d.subarray(0, 10));
          throw ioError('EIO');
        },
      }),
    });

    await expect(store.commit(task.id, { events: [noteEvent('never')] })).rejects.toBeInstanceOf(StoreUnavailableError);
    expect((await newStore(dataDir).readEvents(task.id)).map((e) => e.seq)).toEqual([1]);
  });

  it('6단계 실패, 그러나 전부 쓰인 뒤였음(fsync 실패 등) → 성립했으므로 성공을 돌려준다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const store = newStore(dataDir, {
      ops: opsWith({
        append: async (p, d) => {
          await nodeFileOps.append(p, d);
          if (isEvents(p)) throw ioError('EIO');
        },
      }),
    });

    const result = await store.commit(task.id, { writes: [{ kind: 'task', value: { ...task, title: 'landed' } }], events: [noteEvent('landed')] });
    expect(result.events[0]!.seq).toBe(2);
    expect((await newStore(dataDir).get('task', { taskId: task.id }))?.title).toBe('landed');
  });

  it('6단계 실패 후 성립 여부도 판정하지 못함 → CommitOutcomeUnknownError(firstSeq 포함)', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    let appendFailed = false;
    const store = newStore(dataDir, {
      ops: opsWith({
        append: async (p, d) => {
          if (!isEvents(p)) return nodeFileOps.append(p, d);
          appendFailed = true;
          throw ioError('EIO');
        },
        readFile: async (p) => (appendFailed && isEvents(p) ? Promise.reject(ioError('EIO')) : nodeFileOps.readFile(p)),
      }),
    });

    const error = await store.commit(task.id, { events: [noteEvent('unknown')] }).catch((e) => e);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error.firstSeq).toBe(2);
    expect(error.commitId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // 다음 접근에서 일관되게 복구된다. 호출자는 readEvents 로 성립 여부를 확인한다
    expect((await newStore(dataDir).readEvents(task.id)).length).toBe(1);
  });

  it('7단계(뒷정리 rename) 실패 → commit 은 성공. 결과는 곧바로 보이고, 다음 쓰기는 뒷정리가 끝나야 진행된다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    let blocked = true; // 다른 프로그램이 task.yaml 을 열고 있는 상황
    const ops = opsWith({ rename: async (from, to) => (blocked && from.endsWith('.tmp') ? Promise.reject(ioError('EPERM')) : nodeFileOps.rename(from, to)) });
    const store = newStore(dataDir, { ops });

    const result = await store.commit(task.id, { writes: [{ kind: 'task', value: { ...task, title: 'visible' } }], events: [noteEvent('visible')] });
    expect(result.events[0]!.seq).toBe(2);
    expect(pendingDirs(dataDir, task.id).length).toBe(1);

    // 성립한 commit 의 결과가 안 보이는 일은 없다
    expect((await store.get('task', { taskId: task.id }))?.title).toBe('visible');
    expect((await store.readEvents(task.id)).length).toBe(2);

    // 뒷정리가 끝나지 않은 채로 다음 commit 을 쌓지 않는다: 디스크를 건드리지 않고 물러난다
    const before = snapshot(dataDir);
    await expect(store.commit(task.id, { events: [noteEvent('blocked')] })).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(snapshot(dataDir)).toEqual(before);

    blocked = false;
    expect((await store.commit(task.id, { events: [noteEvent('after')] })).events[0]!.seq).toBe(3);
    expect(pendingDirs(dataDir, task.id)).toEqual([]);
    expect(readText(join(dataDir, task.id, 'task.yaml'))).toContain('title: visible');
  });

  it('일시적 오류(EPERM/EBUSY)는 재시도로 넘어간다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    let failures = 2;
    const store = newStore(dataDir, { ops: opsWith({ rename: async (from, to) => (from.endsWith('.tmp') && failures-- > 0 ? Promise.reject(ioError('EBUSY')) : nodeFileOps.rename(from, to)) }) });

    await store.commit(task.id, { writes: [{ kind: 'task', value: { ...task, title: 'retried' } }], events: [noteEvent('x')] });
    expect(pendingDirs(dataDir, task.id)).toEqual([]);
    expect(readText(join(dataDir, task.id, 'task.yaml'))).toContain('title: retried');
  });

  it('commit.json 을 일시적으로 읽지 못하는 것과 없는 것을 구별한다 — 읽지 못하면 메모를 지우지 않는다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const crashed = await spawnChild({ dataDir, action: 'update', taskId: task.id, title: 'committed', crashAt: 'after-append' }).exit;
    expect(crashed.code).toBe(9);

    const flaky = newStore(dataDir, { ops: opsWith({ readFile: async (p) => (p.endsWith('commit.json') ? Promise.reject(ioError('EBUSY')) : nodeFileOps.readFile(p)) }) });
    await expect(flaky.commit(task.id, { events: [noteEvent('x')] })).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(pendingDirs(dataDir, task.id).length).toBe(1); // 성립한 commit 의 엔티티 쓰기를 잃지 않았다

    expect((await newStore(dataDir).get('task', { taskId: task.id }))?.title).toBe('committed');
  });
});

describe('읽기 절차 (2.7): 파일 시각에 의존하지 않는 표식', () => {
  it('읽는 도중 다른 commit 이 성립하면 그 읽기를 버리고 다시 읽는다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const writer = newStore(dataDir);
    let reads = 0;
    const reader = newStore(dataDir, {
      ops: opsWith({
        readFile: async (p) => {
          const content = await nodeFileOps.readFile(p);
          // 첫 읽기에서 내용을 읽은 직후, 돌려주기 전에 commit 이 끼어든다
          if (isEvents(p) && reads++ === 0) await writer.commit(task.id, { events: [noteEvent('interleaved')] });
          return content;
        },
      }),
    });

    expect((await reader.readEvents(task.id)).length).toBe(2); // 끼어든 commit 이전의 낡은 내용(1개)을 돌려주지 않는다
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('읽는 도중 "append 후 되돌리기" 가 일어나 크기가 원래대로 돌아와도 알아챈다', async () => {
    const dataDir = tempDataDir();
    const task = await createSample(newStore(dataDir));
    const eventsFile = join(dataDir, task.id, 'events.jsonl');
    const original = readText(eventsFile);
    let reads = 0;
    const seen: string[] = [];
    const reader = newStore(dataDir, {
      ops: opsWith({
        readFile: async (p) => {
          if (!isEvents(p) || reads++ > 0) return nodeFileOps.readFile(p);
          // 창 안에서: 다른 프로세스가 메모를 쓰고 일부만 append 한 뒤 죽고, 또 다른 프로세스가 그것을 되돌린다
          const line = JSON.stringify({ seq: 2, task_id: task.id, type: 'task.done', actor: 'system', at: '2026-01-01T00:00:00Z' });
          mkdirSync(join(dataDir, task.id, '.pending-dead'));
          writeFileSync(join(dataDir, task.id, '.pending-dead', 'commit.json'), JSON.stringify({ token: 'dead', firstSeq: 2, lines: [line], files: [] }));
          appendFileSync(eventsFile, line.slice(0, 20));
          const doomed = await nodeFileOps.readFile(p); // reader 가 실제로 보게 되는, 곧 사라질 내용
          seen.push(doomed.toString());
          // 다른 reader 가 복구(되돌리기)를 일으킨다. 뒤따르는 commit 은 없다: events.jsonl 의 크기는 원래대로 돌아온다
          await newStore(dataDir).get('task', { taskId: task.id });
          expect(readText(eventsFile)).toBe(original);
          return doomed;
        },
      }),
    });

    const events = await reader.readEvents(task.id);
    expect(seen[0]!.length).toBeGreaterThan(original.length); // 잘린 줄을 실제로 읽었다
    expect(events.every((e) => e.type !== 'task.done')).toBe(true); // 그러나 돌려주지는 않았다
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(readText(join(dataDir, task.id, '.rollbacks')).length).toBe(1);
  });
});
