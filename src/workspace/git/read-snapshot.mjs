import { createHash } from 'node:crypto';
import { readdir, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Include ignored files and file contents: git status alone misses both ignored
// writes and content changes to files which were already dirty before review.
export async function readSnapshot(root, expectedVersion) {
  const digest = createHash('sha256');
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      if (!prefix && name === '.git') continue;
      const path = join(dir, name), key = `${prefix}${name}`;
      const stat = await lstat(path);
      digest.update(JSON.stringify([key, stat.mode]));
      if (stat.isSymbolicLink()) {
        // A junction can expose mutable external caches. Do not claim isolation.
        throw new Error('read execution does not support workspace symlinks/junctions');
      } else if (stat.isDirectory()) await walk(path, `${key}/`);
      else if (stat.isFile()) {
        const file = await open(path, 'r');
        try { for await (const part of file.createReadStream({ autoClose: false })) digest.update(part); }
        finally { await file.close(); }
      } else throw new Error('read execution requires regular files');
    }
  }
  await walk(root);
  const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // Intake's private empty cwd deliberately has no Git repository.
  try {
    const head = git('rev-parse', 'HEAD'), branch = git('symbolic-ref', '--short', '-q', 'HEAD');
    if (expectedVersion && (head.trim() !== expectedVersion.head || branch.trim() !== expectedVersion.branch || git('status', '--porcelain', '--untracked-files=all').trim())) throw new Error('workspace differs from pinned read version');
    digest.update(head); digest.update(branch); digest.update(git('ls-files', '--stage', '-z'));
  }
  catch (error) { if (expectedVersion || !String(error.stderr).includes('not a git repository')) throw error; }
  return digest.digest('hex');
}
