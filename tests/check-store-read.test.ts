// scripts/check-store-read.mjs (T-0005 AC7 의 확인 명령)을 자식 프로세스로 실제로 실행한다.
// 빌드는 테스트의 global setup 이 만든 것을 DEVFLOW_STORE_BUILD 로 넘겨 다시 하지 않는다.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILD_DIR, REPO_ROOT } from './store/paths.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'devflow-check-store-read-'));
  // 손으로 쓴 실제 기록의 모양(Task·Step 수준 runs/ 의 Run 과 blob, meta 둘, next_step.step 이 있는 Decision)
  cpSync(join(REPO_ROOT, 'tests', 'fixtures', 'validate-data', 'data'), tmp, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function check() {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-store-read.mjs'), tmp], {
    encoding: 'utf8',
    env: { ...process.env, DEVFLOW_STORE_BUILD: BUILD_DIR },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

describe('check-store-read (AC7 의 확인 명령)', () => {
  it('모든 kind 를 읽고 수가 파일 수와 같으면 exit 0 — 기대값은 파일에서 센다', () => {
    const r = check();
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain('T-9002: step 1/1, decision 1/1, feedback 0/0, run 2/2, gate_result 0/0, artifact 2/2, blob 3/3');
    expect(r.stdout).toContain('ok:');
  });

  it('읽지 못한 기록(invalid), blob 으로 풀리지 않는 파일은 FAIL 이고 exit 1', () => {
    writeFileSync(join(tmp, 'T-9002', 'steps', 'step-001', 'runs', 'R-002.yaml'), 'id: R-002\n');
    writeFileSync(join(tmp, 'T-9002', 'runs', 'R-001.x.json.md'), 'x');
    const r = check();
    expect(r.status, r.all).toBe(1);
    expect(r.stderr).toContain('FAIL T-9002 run: invalid');
    expect(r.stderr).toContain('FAIL T-9002/runs/R-001.x.json.md: not readable');
  });
});
