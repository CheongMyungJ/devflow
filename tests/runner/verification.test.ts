import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalVerifier } from '../../src/verification/local/verifier.js';
import { FileExecutionSettings } from '../../src/settings/file.js';
import { repository, runGit } from '../workspace/helpers.js';
import { until } from './helpers.js';

describe('actual deterministic command execution', () => {
  it('runs declared checks in the Task worktree once, preserves expected failure, and freezes named commands', async () => {
    const s = repository(), workdir = s.clone;
    writeFileSync(join(workdir, '.gitignore'), 'count.txt\n');
    writeFileSync(join(workdir, '.devflow.yaml'), JSON.stringify({ commands: { expected: { run: 'node -e "process.exit(7)"', timeout_sec: 10 } } }));
    runGit(workdir, 'add', '.'); runGit(workdir, 'commit', '-m', 'checks');
    const runnerRoot = join(s.root, 'runner'), verifier = new LocalVerifier(runnerRoot, new FileExecutionSettings());
    const request = { id: randomUUID(), workdir, head: runGit(workdir, 'rev-parse', 'HEAD'), commands: [
      { name: 'count', run: `node -e "require('fs').appendFileSync('count.txt','x')"` },
      { name: 'expected nonzero', run: '@expected', expect: 'failure' as const },
    ] };
    await verifier.prepare(request); expect(await verifier.inspect(request.id)).toEqual({ state: 'prepared' });
    await verifier.submit(request.id);
    const done = await until(() => verifier.inspect(request.id), s => s.state === 'completed');
    expect(done).toMatchObject({ state: 'completed', result: { verdict: 'pass', checks: [{ result: 'pass' }, { result: 'pass', evidence: expect.stringContaining('exit=7') }] } });
    await verifier.prepare(request); expect(await verifier.submit(request.id)).toEqual(done);
    expect(await readFile(join(workdir, 'count.txt'), 'utf8')).toBe('x');
    expect(await readFile(join(runnerRoot, 'verification', request.id, 'plan.json'), 'utf8')).toContain('process.exit(7)');
  });
  it('does not replace a claimed execution with unavailable evidence', async () => {
    const s = repository(), root = join(s.root, 'runner'), verifier = new LocalVerifier(root);
    const request = { id: randomUUID(), workdir: s.clone, head: s.initial, commands: [{ name: 'must not run', run: 'node -e "process.exit(0)"' }] };
    await verifier.prepare(request); await mkdir(join(root, 'verification', request.id, 'launch-claim'));
    expect(await verifier.submit(request.id)).toEqual({ state: 'unknown' });
    expect(await verifier.submit(request.id)).toEqual({ state: 'unknown' });
  });
  it('records an unexpected nonzero exit as a failure', async () => {
    const s = repository(), verifier = new LocalVerifier(join(s.root, 'runner'));
    const request = { id: randomUUID(), workdir: s.clone, head: s.initial, commands: [{ name: 'failed check', run: 'node -e "process.exit(3)"' }] };
    await verifier.prepare(request); await verifier.submit(request.id);
    expect(await until(() => verifier.inspect(request.id), s => s.state === 'completed')).toMatchObject({ result: { verdict: 'fail' } });
  });
  it('invalidates a zero-exit check that changes the pinned worktree and keeps its receipt recoverable', async () => {
    const s = repository(), root = join(s.root, 'runner'), verifier = new LocalVerifier(root);
    const request = { id: randomUUID(), workdir: s.clone, head: s.initial, commands: [{ name: 'changes files', run: `node -e "require('fs').writeFileSync('tracked.txt','changed')"` }] };
    expect(await verifier.inspect(request.id)).toEqual({ state: 'missing' });
    await verifier.prepare(request); await verifier.submit(request.id);
    const result = await until(() => verifier.inspect(request.id), s => s.state === 'completed');
    expect(result).toMatchObject({ result: { verdict: 'fail', checks: [{ evidence: expect.stringContaining('invalidated') }] } });
    expect(await new LocalVerifier(root).inspect(request.id)).toEqual(result);
    expect(await readFile(join(s.clone, 'tracked.txt'), 'utf8')).toBe('changed');
  });
});
