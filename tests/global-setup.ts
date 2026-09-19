// 다중 프로세스 테스트의 자식 프로세스는 TypeScript 를 직접 실행할 수 없으므로 한 번 빌드해 둔다.
import { execSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BUILD_DIR, REPO_ROOT } from './store/paths.js';

/** src/ 의 .mjs(스키마 로더 src/schema/registry.mjs 등). tsc 는 이것을 출력 디렉터리로 옮기지 않는다. */
function mjsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? mjsFiles(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : [],
  );
}

export default function setup(): void {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  execSync(`npx tsc -p . --outDir "${BUILD_DIR}"`, { cwd: REPO_ROOT, stdio: 'pipe' });
  for (const file of mjsFiles(join(REPO_ROOT, 'src'))) cpSync(file, join(BUILD_DIR, relative(REPO_ROOT, file)));
}
