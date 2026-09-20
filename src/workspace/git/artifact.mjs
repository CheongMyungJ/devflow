// Read-only end-of-process evidence. Git/path knowledge stays inside the Git implementation.
import { execFileSync } from 'node:child_process';
export function captureCode(workdir, expected) {
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd: workdir, encoding: 'utf8', windowsHide: true, timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  const branch = git('symbolic-ref', '--short', 'HEAD');
  const head = git('rev-parse', '--verify', 'HEAD^{commit}');
  if (branch !== expected.branch || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('Task branch mismatch');
  git('merge-base', '--is-ancestor', expected.baseSha, head);
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Uncommitted changes are not a committed code artifact');
  if (git('rev-parse', 'HEAD') !== head) throw new Error('HEAD moved while capturing');
  return { base_sha: expected.baseSha, head_sha: head };
}
