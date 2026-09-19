// scripts/lib/build.mjs — 입구의 빌드 캐시 (T-0006 step-002, docs/design/commands.md 6.5).
// repo 의 소스를 고칠 수 없으므로 src/·tsconfig.json·package-lock.json 의 사본을 node_modules/.cache 아래(의존성과 schemas/ 를 위로 올라가며
// 찾을 수 있는 자리)에 두고 그것을 빌드한다. 사본에는 생성 타입(src/types/generated)을 넣지 않는다 — 생성 타입 없이도 빌드되고 돌아야 한다.
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildKey, prepareBuild, TSC_ARGS } from '../scripts/lib/build.mjs';
import { REPO_ROOT } from './store/paths.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
afterEach(() => vi.mocked(renameSync).mockReset());

const ROOT = mkdtempSync(join(REPO_ROOT, 'node_modules', '.cache', 'devflow-test-build-cache-'));
const repo = join(ROOT, 'repo');
const cacheDir = join(ROOT, 'cache');
const data = mkdtempSync(join(tmpdir(), 'devflow-build-cache-data-'));

beforeAll(() => {
  cpSync(join(REPO_ROOT, 'src'), join(repo, 'src'), { recursive: true, filter: (src) => !src.replaceAll('\\', '/').includes('src/types/generated') });
  for (const name of ['tsconfig.json', 'package-lock.json', 'package.json']) cpSync(join(REPO_ROOT, name), join(repo, name));
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const builds = () => readdirSync(cacheDir).filter((name) => !name.startsWith('.tmp-'));

describe('입구의 빌드 캐시', () => {
  it('처음에는 tsc --noCheck 로 빌드하고, 생성 타입 없이도 빌드된 command 와 Store 가 돈다', async () => {
    expect(existsSync(join(repo, 'src', 'types', 'generated'))).toBe(false);
    expect(TSC_ARGS).toContain('--noCheck');
    const first = prepareBuild({ repoRoot: repo, cacheDir });
    expect(first.outcome).toBe('built');
    expect(JSON.parse(readFileSync(join(first.dir, 'stamp.json'), 'utf8')).key).toBe(first.key);
    // tsc 가 옮기지 않는 .mjs 도 있다
    expect(existsSync(join(first.dir, 'src', 'store', 'file', 'names.mjs'))).toBe(true);
    expect(existsSync(join(first.dir, 'src', 'schema', 'registry.mjs'))).toBe(true);

    const commands = await import(pathToFileURL(join(first.dir, 'src', 'commands', 'index.js')).href);
    const { FileStore } = await import(pathToFileURL(join(first.dir, 'src', 'store', 'file', 'index.js')).href);
    const ctx = { store: new FileStore({ dataDir: data }), clock: commands.systemClock, actor: 'human:tester' };
    const task = await commands.createTask(ctx, { title: 't', type: 'feature', goal: 'g', acceptance_criteria: [{ id: 'AC1', text: 't' }], target: { repo: 'r', base_branch: 'main' } });
    const [e] = await commands.appendEvents(ctx, { taskId: task.id, events: [{ type: 'ledger.updated' }] });
    expect(e.seq).toBe(2);
  });

  it('소스가 같으면 다시 쓰고, 소스·tsconfig·package-lock 의 내용이 바뀌면 다시 빌드한다 (파일 시각이 아니라 내용)', () => {
    const base = prepareBuild({ repoRoot: repo, cacheDir });
    expect(base.outcome).toBe('reused');

    appendFileSync(join(repo, 'src', 'commands', 'time.ts'), '\n// changed\n');
    const afterSource = prepareBuild({ repoRoot: repo, cacheDir });
    expect(afterSource.outcome).toBe('built');
    expect(afterSource.key).not.toBe(base.key);
    expect(readFileSync(join(afterSource.dir, 'src', 'commands', 'time.js'), 'utf8')).toContain('// changed');
    expect(builds()).toEqual([afterSource.dir.split(/[\\/]/).at(-1)]); // 옛 키의 빌드는 지운다

    // .mjs(빌드 없이 복사되는 소스)도 본다
    appendFileSync(join(repo, 'src', 'store', 'file', 'names.mjs'), '\n// changed\n');
    const afterMjs = prepareBuild({ repoRoot: repo, cacheDir });
    expect(afterMjs.outcome).toBe('built');
    expect(readFileSync(join(afterMjs.dir, 'src', 'store', 'file', 'names.mjs'), 'utf8')).toContain('// changed');

    writeFileSync(join(repo, 'tsconfig.json'), `${readFileSync(join(repo, 'tsconfig.json'), 'utf8')}\n`);
    expect(prepareBuild({ repoRoot: repo, cacheDir }).outcome).toBe('built');

    writeFileSync(join(repo, 'package-lock.json'), `${readFileSync(join(repo, 'package-lock.json'), 'utf8')}\n`);
    const afterLock = prepareBuild({ repoRoot: repo, cacheDir });
    expect(afterLock.outcome).toBe('built');
    expect(prepareBuild({ repoRoot: repo, cacheDir }).outcome).toBe('reused');

    // 새 파일도
    writeFileSync(join(repo, 'src', 'commands', 'extra.ts'), 'export const extra = 1;\n');
    expect(prepareBuild({ repoRoot: repo, cacheDir }).outcome).toBe('built');
  });

  it('tsc 인자와 로더 자신의 내용도 빌드 키에 들어간다', () => {
    const key = buildKey({ repoRoot: repo });
    expect(buildKey({ repoRoot: repo })).toBe(key);
    expect(buildKey({ repoRoot: repo, tscArgs: [...TSC_ARGS, '--removeComments'] })).not.toBe(key);
    expect(buildKey({ repoRoot: repo, loaderText: '// another loader' })).not.toBe(key);

    const withArgs = prepareBuild({ repoRoot: repo, cacheDir, tscArgs: [...TSC_ARGS, '--removeComments'] });
    expect(withArgs.outcome).toBe('built');
    expect(readFileSync(join(withArgs.dir, 'src', 'commands', 'time.js'), 'utf8')).not.toContain('// changed');
  });

  it('제자리의 빌드가 다른 키의 것(stamp 가 다르다)이면 쓰지 않고 다시 빌드한다', () => {
    const current = prepareBuild({ repoRoot: repo, cacheDir });
    writeFileSync(join(current.dir, 'stamp.json'), JSON.stringify({ key: 'something else' }));
    // rename 이 부딪히고 stamp 가 다르므로 오류 — 온전하지 않은 빌드를 쓰지 않는다
    expect(() => prepareBuild({ repoRoot: repo, cacheDir })).toThrow();
    rmSync(current.dir, { recursive: true, force: true });
    expect(prepareBuild({ repoRoot: repo, cacheDir }).outcome).toBe('built');
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('일시적 %s 뒤에는 완성된 빌드를 게시하고 다시 사용한다', (code) => {
    const cache = join(ROOT, `transient-${code}`);
    const rename = vi.mocked(renameSync);
    const blocked = Object.assign(new Error('temporarily blocked'), { code });
    rename.mockImplementationOnce(() => { throw blocked; });
    const result = prepareBuild({ repoRoot: repo, cacheDir: cache });
    expect(result.outcome).toBe('built');
    expect(rename.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readFileSync(join(result.dir, 'stamp.json'), 'utf8')).key).toBe(result.key);
    expect(readdirSync(cache).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    expect(prepareBuild({ repoRoot: repo, cacheDir: cache }).outcome).toBe('reused');
  });

  it('영구 EPERM은 제한 시간 뒤 원래 오류로 실패하고 불완전한 빌드를 게시하지 않는다', () => {
    const cache = join(ROOT, 'permanent-permission');
    const blocked = Object.assign(new Error('permanently blocked'), { code: 'EPERM' });
    const rename = vi.mocked(renameSync).mockImplementation(() => { throw blocked; });
    expect(() => prepareBuild({ repoRoot: repo, cacheDir: cache })).toThrow(blocked);
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    expect(readdirSync(cache)).toEqual([]);
  });

  it('재시도 중 같은 키의 빌드가 먼저 게시되면 그 빌드를 쓰고 자기 임시 폴더만 지운다', async () => {
    const cache = join(ROOT, 'retry-race');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const blocked = Object.assign(new Error('temporarily blocked'), { code: 'EPERM' });
    vi.mocked(renameSync)
      .mockImplementationOnce(() => { throw blocked; })
      .mockImplementationOnce((from, to) => {
        fs.cpSync(String(from), String(to), { recursive: true }); // 다른 프로세스가 같은 완성본을 먼저 게시한 상태
        throw blocked;
      });
    const result = prepareBuild({ repoRoot: repo, cacheDir: cache });
    expect(result.outcome).toBe('raced');
    expect(JSON.parse(readFileSync(join(result.dir, 'stamp.json'), 'utf8')).key).toBe(result.key);
    expect(readdirSync(cache)).toEqual([result.key.slice(0, 32)]);
    expect(prepareBuild({ repoRoot: repo, cacheDir: cache }).outcome).toBe('reused');
  });

  it('재시도 대상이 아닌 오류는 즉시 전파한다', () => {
    const cache = join(ROOT, 'permanent-io');
    const broken = Object.assign(new Error('I/O failed'), { code: 'EIO' });
    const rename = vi.mocked(renameSync).mockImplementation(() => { throw broken; });
    expect(() => prepareBuild({ repoRoot: repo, cacheDir: cache })).toThrow(broken);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(readdirSync(cache)).toEqual([]);
  });
});
