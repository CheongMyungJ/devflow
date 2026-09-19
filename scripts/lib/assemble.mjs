// 입구(scripts/*.mjs)의 조립 지점 (docs/design/commands.md 1절, 5절, 6.5). 입구는 여기서 command 와 CommandContext 를 받아 command 만 부른다.
// Store 의 파일 구현체를 여는 곳은 scripts/ 에서 이 모듈과 검증 스크립트 check-store-read 뿐이다(AGENTS.md 1·2번 — tests/architecture.test.ts).
// 빌드는 ./build.mjs 가 준비한다.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBuild, REPO_ROOT } from './build.mjs';

/** 실행 중인 devflow 의 commit SHA — 이벤트의 system_sha. 읽지 못하면 기록하지 않고 멈춘다. */
function devflowHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Error('devflow repo 의 HEAD 를 읽지 못했다 — 입구는 git checkout 안에서 돈다', { cause: error });
  }
}

/**
 * 데이터 디렉터리 하나에 대한 command 와 CommandContext 를 만든다. Store 는 프로세스당 하나(commands.md 5절).
 * @param {{ dataDir: string, actor?: string }} options actor 는 `human:<id>` 또는 `system`(기본)
 * @returns {Promise<{ commands: typeof import('../../src/commands/index.js'), ctx: import('../../src/commands/index.js').CommandContext }>}
 */
export async function assemble({ dataDir, actor = 'system' }) {
  const { dir } = prepareBuild();
  const load = (rel) => import(pathToFileURL(join(dir, rel)).href);
  const commands = await load('src/commands/index.js');
  const { FileStore } = await load('src/store/file/index.js');
  const ctx = { store: new FileStore({ dataDir }), clock: commands.systemClock, actor, systemSha: devflowHead() };
  return { commands, ctx };
}
