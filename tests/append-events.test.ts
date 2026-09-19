// scripts/append-events.mjs (입구)를 자식 프로세스로 실제로 실행한다 (T-0006 step-002, docs/design/commands.md 6.1~6.3, 6.5).
// 입구는 scripts/lib/assemble.mjs 에서 command 와 Context 를 받는다. 빌드는 입구의 캐시(node_modules/.cache/devflow-entry)가 아니라
// 이 파일의 캐시 디렉터리(DEVFLOW_BUILD_CACHE)를 쓰고 끝에 지운다.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentSnapshot, createSample, newStore, tempDataDir } from './store/helpers.js';
import { REPO_ROOT } from './store/paths.js';
import { event, step } from './store/records.js';

const CACHE_ROOT = mkdtempSync(join(REPO_ROOT, 'node_modules', '.cache', 'devflow-test-entry-'));
const inputs = mkdtempSync(join(tmpdir(), 'devflow-append-events-input-'));
afterAll(() => {
  rmSync(CACHE_ROOT, { recursive: true, force: true });
  rmSync(inputs, { recursive: true, force: true });
});

const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECONDS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SCRIPT = join(REPO_ROOT, 'scripts', 'append-events.mjs');

let n = 0;
function eventsFile(events: unknown): string {
  const file = join(inputs, `events-${++n}.json`);
  writeFileSync(file, typeof events === 'string' ? events : JSON.stringify(events));
  return file;
}

function entry(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, DEVFLOW_BUILD_CACHE: join(CACHE_ROOT, 'shared'), ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

async function data() {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  const task = await createSample(store);
  await store.commit(task.id, { writes: [{ kind: 'step', value: step(task.id, 'step-001') }], events: [event('step.defined', { step_id: 'step-001' })] });
  const lines = () => readFileSync(join(dataDir, task.id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  return { dataDir, store, taskId: task.id, lines };
}

describe('append-events 입구', () => {
  it('<data-dir> <task-id> <events.json> 로 appendEvents 를 부른다 — 새 이벤트 모두에 commit_id, 도구가 채운 초 단위 UTC 의 at, system_sha = devflow 의 HEAD', async () => {
    const { dataDir, taskId, lines } = await data();
    const r = entry([dataDir, taskId, eventsFile([{ type: 'ledger.updated', step_id: 'step-001' }, { type: 'decision.answered', data: { note: '답' } }])]);
    expect(r.status, r.all).toBe(0);
    const added = lines().slice(2);
    expect(r.stdout).toContain(`appended 2 events to ${taskId}, seq 3..4, commit ${added[0]!['commit_id']}`);
    expect(added).toEqual([
      { seq: 3, task_id: taskId, commit_id: expect.stringMatching(UUID), type: 'ledger.updated', actor: 'system', step_id: 'step-001', system_sha: HEAD, at: expect.stringMatching(SECONDS_UTC) },
      { seq: 4, task_id: taskId, commit_id: added[0]!['commit_id'], type: 'decision.answered', actor: 'system', data: { note: '답' }, system_sha: HEAD, at: added[0]!['at'] },
    ]);
    const at = Date.parse(added[0]!['at'] as string);
    expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
    // 입력 파일의 로컬 경로는 어디에도 기록되지 않는다
    expect(readFileSync(join(dataDir, taskId, 'events.jsonl'), 'utf8')).not.toContain(inputs.replaceAll('\\', '\\\\'));
  });

  it('--actor human:<id> 를 이벤트의 actor 로 쓴다', async () => {
    const { dataDir, taskId, lines } = await data();
    const r = entry([dataDir, taskId, eventsFile([{ type: 'ledger.updated' }]), '--actor', 'human:CheongMyungJ']);
    expect(r.status, r.all).toBe(0);
    expect(lines().at(-1)).toMatchObject({ actor: 'human:CheongMyungJ', commit_id: expect.stringMatching(UUID) });
  });

  const rejections: { label: string; args: (d: { dataDir: string; taskId: string }) => string[]; status: number; message: RegExp }[] = [
    { label: '옛 인자 모양 <task-dir> <events.json>', args: ({ dataDir, taskId }) => [join(dataDir, taskId), eventsFile([{ type: 'ledger.updated' }])], status: 2, message: /옛 인자 모양/ },
    { label: '인자가 모자란다', args: ({ dataDir }) => [dataDir], status: 2, message: /usage: append-events <data-dir> <task-id> <events.json>/ },
    { label: 'task id 의 모양', args: ({ dataDir }) => [dataDir, '../T-0001', eventsFile([{ type: 'ledger.updated' }])], status: 2, message: /T-NNNN 모양이 아니다/ },
    { label: '--actor 의 모양', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile([{ type: 'ledger.updated' }]), '--actor', 'CheongMyungJ'], status: 2, message: /human:<id>/ },
    { label: '모르는 옵션(시각을 주는 길은 없다)', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile([{ type: 'ledger.updated' }]), '--at', '2026-01-01T00:00:00Z'], status: 2, message: /모르는 옵션 --at/ },
    { label: '입력의 at', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile([{ type: 'ledger.updated', at: '2026-09-19T00:00:00Z' }])], status: 1, message: /events\[0\]\.at: 도구가 채우는 필드다/ },
    { label: '입력의 actor·system_sha·seq·task_id·commit_id', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile([{ type: 'ledger.updated', actor: 'system', system_sha: 'x', seq: 3, task_id: taskId, commit_id: 'x' }])], status: 1, message: /events\[0\]\.commit_id: 도구가 채우는 필드다/ },
    { label: 'command 가 쓰는 이벤트(step.status_changed)', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile([{ type: 'step.status_changed', step_id: 'step-001', data: { from: 'defined', to: 'running' } }])], status: 1, message: /step\.status_changed 는 .* append-events 로 넣지 않는다/ },
    { label: 'command 가 쓰는 이벤트(task.done)', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile([{ type: 'task.done' }])], status: 1, message: /task\.done 는 completeTask/ },
    { label: 'command 가 쓰는 이벤트(gate.completed)', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile([{ type: 'gate.completed', step_id: 'step-001' }])], status: 1, message: /gate\.completed 는 recordGate/ },
    { label: '없는 Task', args: ({ dataDir }) => [dataDir, 'T-0009', eventsFile([{ type: 'ledger.updated' }])], status: 1, message: /TaskNotFoundError: task not found: T-0009/ },
    { label: 'JSON 이 아닌 파일', args: ({ dataDir, taskId }) => [dataDir, taskId, eventsFile('not json')], status: 1, message: /events\.json 을 읽지 못했다/ },
  ];
  it.each(rejections)('아무것도 쓰기 전에 거부한다: $label', async ({ args, status, message }) => {
    const d = await data();
    const before = contentSnapshot(d.dataDir);
    const r = entry(args(d));
    expect(r.status, r.all).toBe(status);
    expect(r.stderr).toMatch(message);
    expect(contentSnapshot(d.dataDir)).toEqual(before);
  });

  it('동시에 부른 두 입구가 둘 다 빌드하게 되어도 둘 다 온전한 빌드를 쓰고 성공한다 — 빌드가 실제로 겹쳤음을 시각으로 확인한다', async () => {
    const { dataDir, store, lines } = await data();
    const second = await createSample(store);
    const cache = join(CACHE_ROOT, 'concurrent'); // 비어 있다 — 둘 다 캐시를 찾지 못하고 빌드한다
    const launch = (taskId: string) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, dataDir, taskId, eventsFile([{ type: 'ledger.updated' }])], {
          env: { ...process.env, DEVFLOW_BUILD_CACHE: cache, DEVFLOW_BUILD_TRACE: '1', DEVFLOW_BUILD_HOLD_MS: '1500' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => (stdout += b));
        child.stderr.on('data', (b) => (stderr += b));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    const results = await Promise.all([launch('T-0001'), launch(second.id)]);
    for (const r of results) expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);

    const traces = results.map((r) => JSON.parse(r.stderr.trim().split('\n').find((l) => l.startsWith('{"build"'))!) as { build: string; dir: string; start: number; end: number });
    expect(traces.map((t) => t.build).sort()).toEqual(['built', 'raced']);
    expect(traces[0]!.dir).toBe(traces[1]!.dir);
    // 겹쳤다: 각자의 빌드(시작 ~ rename 직전)가 상대의 빌드와 시간이 겹친다 — 순서대로 돈 것이 아니다
    expect(traces[0]!.start).toBeLessThan(traces[1]!.end);
    expect(traces[1]!.start).toBeLessThan(traces[0]!.end);

    expect(lines().at(-1)).toMatchObject({ type: 'ledger.updated', commit_id: expect.stringMatching(UUID) });
    const other = readFileSync(join(dataDir, second.id, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(other.at(-1)!)).toMatchObject({ type: 'ledger.updated', commit_id: expect.stringMatching(UUID) });

    // 다음 호출은 그 빌드를 다시 쓴다. 임시 디렉터리는 남지 않는다
    const again = entry([dataDir, 'T-0001', eventsFile([{ type: 'ledger.updated' }])], { DEVFLOW_BUILD_CACHE: cache, DEVFLOW_BUILD_TRACE: '1' });
    expect(again.status, again.all).toBe(0);
    expect(again.stderr).toContain('"build":"reused"');
    expect(readdirSync(cache)).toEqual([traces[0]!.dir.split(/[\\/]/).at(-1)]);
  }, 60_000);
});
