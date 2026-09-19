// 입구(scripts/*.mjs)를 자식 프로세스로 실행하는 테스트의 도우미. 빌드는 입구의 캐시가 아니라 파일마다의 캐시(DEVFLOW_BUILD_CACHE)를 쓰고 끝에 지운다.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { REPO_ROOT } from './store/paths.js';

export interface EntryResult {
  status: number | null;
  stdout: string;
  stderr: string;
  all: string;
}

/** 이 테스트 파일의 빌드 캐시와 입력 파일 디렉터리(데이터 디렉터리 밖). afterAll 에 지운다. */
export function entryRunner(label: string) {
  const cache = mkdtempSync(join(REPO_ROOT, 'node_modules', '.cache', `devflow-test-entry-${label}-`));
  const inputs = mkdtempSync(join(tmpdir(), `devflow-${label}-input-`));
  afterAll(() => {
    rmSync(cache, { recursive: true, force: true });
    rmSync(inputs, { recursive: true, force: true });
  });
  let n = 0;
  return {
    inputs,
    /** 입력 파일을 데이터 디렉터리 밖에 쓴다. */
    file(content: string, name = 'input.txt'): string {
      const file = join(inputs, `${++n}-${name}`);
      writeFileSync(file, content);
      return file;
    },
    run(entry: string, args: string[], env: Record<string, string> = {}): EntryResult {
      const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', `${entry}.mjs`), ...args], {
        encoding: 'utf8',
        env: { ...process.env, DEVFLOW_BUILD_CACHE: join(cache, 'shared'), ...env },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
    },
  };
}

/** 데이터 디렉터리의 모든 파일 내용을 이어 붙인 것 — 입력의 로컬 경로가 어디에도 기록되지 않았는지 보는 데 쓴다. */
export function allText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}

/** 로컬 경로가 기록에 들어갔는가 — 그대로, JSON 이스케이프, 슬래시로 바꾼 모양. */
export function containsPath(text: string, path: string): boolean {
  return [path, path.replaceAll('\\', '\\\\'), path.replaceAll('\\', '/')].some((p) => text.includes(p));
}

export const VALIDATE_DATA = join(REPO_ROOT, 'scripts', 'validate-data.mjs');
export function validateData(dataDir: string): EntryResult {
  const r = spawnSync(process.execPath, [VALIDATE_DATA, dataDir], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
