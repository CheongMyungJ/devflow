// scripts/lib/build.mjs — 입구의 빌드 캐시 (T-0006 step-002, docs/design/commands.md 6.5).
// repo 의 소스를 고칠 수 없으므로 src/·tsconfig.json·package-lock.json 의 사본을 node_modules/.cache 아래(의존성과 schemas/ 를 위로 올라가며
// 찾을 수 있는 자리)에 두고 그것을 빌드한다. 사본에는 생성 타입(src/types/generated)을 넣지 않는다 — 생성 타입 없이도 빌드되고 돌아야 한다.
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildKey, prepareBuild, TSC_ARGS } from '../scripts/lib/build.mjs';
import { REPO_ROOT } from './store/paths.js';

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
});
