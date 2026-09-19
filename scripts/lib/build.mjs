// 입구(scripts/*.mjs)가 src/ 의 TypeScript(commands, Store)를 부르려고 쓰는 빌드 캐시 (docs/design/commands.md 6.5).
// Node 22 는 src/ 의 .ts 를 그대로 import 하지 못한다. 그래서 `tsc -p . --noCheck` 로 빌드해 두고, 소스의 내용 해시(빌드 키)가 같으면
// 그 빌드를 다시 쓴다. 파일 시각을 보지 않는다. 타입 검사는 `npm run typecheck` 의 일이다 — --noCheck 라 생성 타입(src/types/generated)이
// 없어도 빌드된다(생성 타입은 import type 으로만 쓰여 출력에서 지워진다).
//
// 빌드 키에 들어가는 것: src/ 의 .ts·.mts·.mjs 전부(상대 경로와 내용), tsconfig.json, package-lock.json, 이 디렉터리(scripts/lib/)의
// .mjs 전부(로더 자신과 조립 지점), tsc 인자. 들어가지 않는 것(한계 — commands.md 6.5): 설치된 node_modules 가 lock 과 다른 경우,
// Node·tsc 의 실행 파일 자체, schemas/(빌드에 들어가지 않고 실행 때 registry.mjs 가 repo 의 schemas/ 를 읽는다).
//
// 자리: <cache>/<키 앞 32자>/ — node_modules/.cache/ 아래라 git 이 무시하고, 거기서 위로 올라가며 의존성과 schemas/ 를 찾는다.
// 새 빌드는 <cache>/.tmp-<pid>-<난수>/ 에 만들고 끝에 stamp.json 을 쓴 뒤 rename 으로 제자리에 넣는다. 그래서 제자리에 있는 디렉터리는
// 언제나 온전한 빌드다. 두 프로세스가 동시에 빌드하면 늦은 쪽의 rename 이 이미 있는 디렉터리와 부딪힌다 — 그 디렉터리의 stamp 가
// 같은 키면 그것을 쓰고 자기 임시 디렉터리를 지운다. 다른 키의 옛 빌드는 새 빌드를 넣은 뒤 지운다(지우지 못하면 다음에).
// 대상이 없는 rename의 EPERM·EBUSY·EACCES는 최대 1초 재시도한다. 다른 대상·영구 오류는 그대로 거부한다.
//
// 환경 변수:
//   DEVFLOW_BUILD_CACHE    캐시 디렉터리(기본 node_modules/.cache/devflow-entry). 테스트는 자기 위치를 준다 — 입구의 캐시를 건드리지 않게.
//   DEVFLOW_BUILD_TRACE    1 이면 무엇을 했는지(built / reused / raced)와 빌드 시작·끝 시각을 표준 오류에 JSON 한 줄로 쓴다(테스트용).
//   DEVFLOW_BUILD_HOLD_MS  빌드를 마친 뒤 rename 전에 기다리는 밀리초(테스트용 — 동시 빌드를 확실히 겹치게 한다).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(LIB_DIR, '..', '..');
export const DEFAULT_CACHE_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'devflow-entry');
/** tsc 인자(--outDir 밖). 바꾸면 빌드 키가 바뀐다. */
export const TSC_ARGS = Object.freeze(['-p', '.', '--noCheck']);
const STAMP = 'stamp.json';
/** 이보다 오래된 남의 임시 디렉터리는 끊긴 빌드의 찌꺼기로 보고 지운다. */
const STALE_TMP_MS = 60 * 60 * 1000;
const RENAME_RETRY_MS = 1000;
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

function walk(dir, keep) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), keep) : keep(e.name) ? [join(dir, e.name)] : [],
  );
}

const posix = (path) => path.replaceAll('\\', '/');

/** 로더 자신: 이 디렉터리의 .mjs 전부. */
export function loaderFiles() {
  return walk(LIB_DIR, (name) => name.endsWith('.mjs')).sort();
}

/**
 * 빌드 키(sha256 16진). 같은 키면 같은 빌드다.
 * @param {{ repoRoot?: string, tscArgs?: readonly string[], loaderText?: string }} [options] loaderText 는 테스트가 로더의 내용을 바꿔 보려고 준다.
 */
export function buildKey({ repoRoot = REPO_ROOT, tscArgs = TSC_ARGS, loaderText } = {}) {
  const hash = createHash('sha256');
  const add = (label, content) => {
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    hash.update(`${label}\0${bytes.length}\0`);
    hash.update(bytes);
  };
  add('tsc-args', JSON.stringify(tscArgs));
  add('loader', loaderText ?? Buffer.concat(loaderFiles().map((f) => readFileSync(f))));
  for (const name of ['tsconfig.json', 'package-lock.json']) {
    const file = join(repoRoot, name);
    add(name, existsSync(file) ? readFileSync(file) : '(none)');
  }
  const sources = walk(join(repoRoot, 'src'), (name) => /\.(ts|mts|mjs)$/.test(name))
    .map((f) => ({ rel: posix(relative(repoRoot, f)), f }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const { rel, f } of sources) add(rel, readFileSync(f));
  return hash.digest('hex');
}

function readStamp(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, STAMP), 'utf8'));
  } catch {
    return undefined;
  }
}

function tscBin(repoRoot) {
  const pkg = createRequire(join(repoRoot, 'package.json')).resolve('typescript/package.json');
  return join(dirname(pkg), 'bin', 'tsc');
}

/**
 * 지금 소스의 빌드를 준비하고 그 디렉터리를 돌려준다. 빌드 안에서 src/ 는 <dir>/src/ 다.
 * @param {{ repoRoot?: string, cacheDir?: string, tscArgs?: readonly string[] }} [options]
 * @returns {{ dir: string, key: string, outcome: 'built' | 'reused' | 'raced' }}
 */
export function prepareBuild({ repoRoot = REPO_ROOT, cacheDir = process.env.DEVFLOW_BUILD_CACHE || DEFAULT_CACHE_DIR, tscArgs = TSC_ARGS } = {}) {
  const key = buildKey({ repoRoot, tscArgs });
  const dir = join(cacheDir, key.slice(0, 32));
  const trace = (outcome, extra = {}) => {
    if (process.env.DEVFLOW_BUILD_TRACE === '1') process.stderr.write(`${JSON.stringify({ build: outcome, key, dir, pid: process.pid, ...extra })}\n`);
    return { dir, key, outcome };
  };
  if (readStamp(dir)?.key === key) return trace('reused');

  mkdirSync(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const start = Date.now();
  try {
    try {
      execFileSync(process.execPath, [tscBin(repoRoot), ...tscArgs, '--outDir', tmp], { cwd: repoRoot, stdio: 'pipe' });
    } catch (error) {
      throw new Error(`build failed (tsc ${tscArgs.join(' ')}):\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error });
    }
    // tsc 는 .mjs(src/schema/registry.mjs, src/store/file/names.mjs 등)를 출력으로 옮기지 않는다 (docs/architecture.md 2절)
    for (const file of walk(join(repoRoot, 'src'), (name) => name.endsWith('.mjs'))) cpSync(file, join(tmp, relative(repoRoot, file)));
    writeFileSync(join(tmp, STAMP), `${JSON.stringify({ key, tscArgs })}\n`);
    const hold = Number(process.env.DEVFLOW_BUILD_HOLD_MS);
    if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
    const end = Date.now();
    const deadline = performance.now() + RENAME_RETRY_MS;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        renameSync(tmp, dir);
        break;
      } catch (error) {
        // 같은 키의 온전한 빌드가 먼저 도착했으면 재사용한다. 다른 대상은 덮어쓰지 않는다.
        if (readStamp(dir)?.key === key) return trace('raced', { start, end });
        const remaining = deadline - performance.now();
        // Windows에서 방금 쓴 파일의 일시적 접근 충돌도 EPERM 등으로 온다.
        // 대상이 없을 때만 제한 시간 안에 재시도한다. 영구 오류는 그대로 올린다.
        if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || existsSync(dir) || remaining <= 0) throw error;
        Atomics.wait(wait, 0, 0, Math.min(20, remaining));
      }
    }
    pruneOthers(cacheDir, dir);
    return trace('built', { start, end });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 다른 키의 옛 빌드와 오래된 임시 디렉터리를 지운다. 실패해도 괜찮다(다음에 다시). */
function pruneOthers(cacheDir, keep) {
  for (const name of readdirSync(cacheDir)) {
    const path = join(cacheDir, name);
    if (path === keep) continue;
    try {
      if (name.startsWith('.tmp-') && Date.now() - statSync(path).mtimeMs < STALE_TMP_MS) continue; // 다른 프로세스가 빌드 중일 수 있다
      rmSync(path, { recursive: true, force: true });
    } catch {
      // 다른 프로세스가 쓰고 있거나 이미 지웠다
    }
  }
}
