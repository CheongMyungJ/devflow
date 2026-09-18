// 다중 프로세스 테스트의 자식 프로세스는 TypeScript 를 직접 실행할 수 없으므로 한 번 빌드해 둔다.
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { BUILD_DIR, REPO_ROOT } from './store/paths.js';

export default function setup(): void {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  execSync(`npx tsc -p . --outDir "${BUILD_DIR}"`, { cwd: REPO_ROOT, stdio: 'pipe' });
}
