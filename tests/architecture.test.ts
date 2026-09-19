// AGENTS.md 의 구조 제약을 자동으로 확인한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './store/paths.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

const rel = (file: string) => relative(REPO_ROOT, file).replaceAll('\\', '/');

describe('구조 제약', () => {
  const callers = [...sourceFiles(join(REPO_ROOT, 'src', 'commands')), ...sourceFiles(join(REPO_ROOT, 'src', 'queries'))];

  it('검사 대상이 비어 있지 않다', () => {
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  it('commands 와 queries 는 Store 의 파일 구현체도, 파일 시스템도 직접 쓰지 않는다 (AGENTS.md 1, 2)', () => {
    const offenders = callers.flatMap((file) =>
      importsOf(file)
        .filter((spec) => /store\/file(\/|$)/.test(spec) || /^(node:)?(fs|fs\/promises|path|child_process)$/.test(spec) || spec === 'yaml')
        .map((spec) => `${rel(file)} imports ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it('commands 는 artifact 참조·ID 의 문법을 파일 구현체 밖의 src/store/refs.ts 에서 가져올 수 있다 — 그 모듈은 파일 위치를 모른다', () => {
    const refs = join(REPO_ROOT, 'src', 'store', 'refs.ts');
    expect(importsOf(refs).filter((spec) => spec !== './types.js')).toEqual([]);
    expect(readFileSync(refs, 'utf8')).not.toMatch(/steps\/|\.meta\.yaml|runs\/|gates\//);
  });

  it('파일 구현체를 import 하는 것은 그 디렉터리 자신뿐이다', () => {
    const outside = sourceFiles(join(REPO_ROOT, 'src')).filter((file) => !rel(file).startsWith('src/store/file/'));
    const offenders = outside.flatMap((file) =>
      importsOf(file)
        .filter((spec) => /store\/file(\/|$)/.test(spec) || /^\.\/file(\/|$)/.test(spec))
        .map((spec) => `${rel(file)} imports ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});

// scripts/ (0단계 운영의 입구와 검증 스크립트) — T-0006 AC9, docs/design/commands.md 6.5
describe('구조 제약 — scripts/', () => {
  const SCRIPTS = join(REPO_ROOT, 'scripts');
  const scripts = readdirSync(SCRIPTS, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => ({ rel: `scripts/${name.replaceAll('\\', '/')}`, source: readFileSync(join(SCRIPTS, name), 'utf8') }));
  /** 조립 지점. 빌드를 준비하고 FileStore 를 만들어 CommandContext 를 만든다. */
  const ASSEMBLY = 'scripts/lib/assemble.mjs';
  /** 검증용 스크립트: 파일 구현체를 빌드에서 직접 연다 (docs/architecture.md 2절). */
  const VERIFIER = 'scripts/check-store-read.mjs';
  /** 파일 구현체의 이름 규칙 모듈만 import 한다(빌드 없이 돈다 — src/store/file/names.mjs). */
  const RULE_USERS = ['scripts/validate-data.mjs'];
  /** Store 로 쓰는 입구. 조립 지점에서 command 를 받아 command 만 부른다. */
  const ENTRIES = ['scripts/append-events.mjs'];

  /** 파일 구현체(src/store/file/)를 가리키는 곳 — 정적 import, 동적 import, 경로 조각으로 만든 경로('store', 'file'). */
  const fileImplRefs = (source: string) => {
    const code = source.replace(/^\s*\/\/.*$/gm, ''); // 주석 줄은 뺀다
    return [...code.matchAll(/store[\\/]file[\\/][\w./-]*|'store',\s*'file'(?:,\s*'[\w.]+')*/g)].map((m) => m[0]);
  };

  it('검사 대상이 있다', () => {
    expect(scripts.map((s) => s.rel)).toEqual(expect.arrayContaining([ASSEMBLY, VERIFIER, ...RULE_USERS, ...ENTRIES]));
  });

  it('scripts/ 에서 Store 파일 구현체를 여는 곳은 조립 지점과 check-store-read 뿐이다 (validate-data 는 이름 규칙 모듈만)', () => {
    const offenders = scripts.flatMap(({ rel, source }) => {
      const refs = fileImplRefs(source);
      if (rel === ASSEMBLY || rel === VERIFIER) return [];
      if (RULE_USERS.includes(rel)) return refs.filter((r) => r !== 'store/file/names.mjs').map((r) => `${rel} → ${r}`);
      return refs.map((r) => `${rel} → ${r}`);
    });
    expect(offenders).toEqual([]);
    expect(fileImplRefs(scripts.find((s) => s.rel === ASSEMBLY)!.source)).toEqual(['store/file/index.js']);
  });

  it('입구는 조립 지점에서 command 와 Context 를 받아 commands.* 만 부른다 — Store 를 직접 부르지 않고 데이터 디렉터리에 파일을 쓰지 않는다', () => {
    for (const rel of ENTRIES) {
      const source = scripts.find((s) => s.rel === rel)!.source;
      const specs = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      expect(specs.filter((spec) => !spec.startsWith('node:')), rel).toEqual(['./lib/assemble.mjs']);
      expect(specs.filter((spec) => /^node:fs/.test(spec)), rel).toEqual(['node:fs']);
      expect(source, rel).not.toMatch(/\bwriteFileSync|appendFileSync|mkdirSync|renameSync|rmSync\b/);
      expect(source, rel).not.toMatch(/\.store\b|FileStore/);
      expect(source, rel).toMatch(/commands\.\w+\(ctx,/);
    }
  });

  it('npm 명령 이름이 그대로 남고, 입구에 pre 스크립트를 달지 않는다', () => {
    const { scripts: npm } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(npm['append-events']).toBe('node scripts/append-events.mjs');
    for (const name of ['validate-data', 'propose-step', 'record-gate']) expect(npm[name]).toBe(`node scripts/${name}.mjs`);
    expect(npm['preappend-events']).toBeUndefined();
  });
});
