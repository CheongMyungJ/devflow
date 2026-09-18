import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** node_modules 아래라 git 에 잡히지 않고, 거기서도 repo 의 schemas/ 를 찾을 수 있다. */
export const BUILD_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'devflow-test-build');
export const CHILD_SCRIPT = join(REPO_ROOT, 'tests', 'store', 'fixtures', 'child.mjs');
