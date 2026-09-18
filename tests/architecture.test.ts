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
