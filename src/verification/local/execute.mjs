import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { publish, readJson } from '../../runner/local/files.mjs';

const dir = process.argv[2];
await mkdir(join(dir, 'supervisor-claim')); // Permanent: never run a declared check twice after ambiguous termination.
const request = await readJson(dir, 'plan.json');
const server = createServer(socket => socket.end(request.id));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await publish(dir, 'owner.json', { id: request.id, port: server.address().port });
const git = args => execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: request.workdir, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
const checks = [];
try {
  if (git(['rev-parse', 'HEAD']) !== request.head || git(['status', '--porcelain']).length) throw new Error('Pinned worktree changed before verification');
  for (const [index, check] of request.commands.entries()) {
    const outcome = await new Promise(resolve => {
      // Declared commands intentionally use the host shell; never interpolate human HITL text here.
      const child = spawn(check.run, { shell: true, cwd: request.workdir, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', timedOut = false, spawnFailed = false;
      const append = bytes => { if (output.length < 1024 * 1024) output += bytes.toString().slice(0, 1024 * 1024 - output.length); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }, check.timeoutSeconds * 1000);
      child.on('error', () => { spawnFailed = true; });
      child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, spawnFailed, output }); });
    });
    await writeFile(join(dir, `check-${index}.log`), outcome.output, { flag: 'wx' });
    const passed = !outcome.timedOut && !outcome.spawnFailed && outcome.code !== null && ((check.expect ?? 'success') === 'failure' ? outcome.code !== 0 : outcome.code === 0);
    checks.push({ kind: 'deterministic', name: check.name, result: passed ? 'pass' : 'fail', evidence: `exit=${outcome.code}; expect=${check.expect ?? 'success'}; timeout=${outcome.timedOut}; spawn_failed=${outcome.spawnFailed}` });
  }
  if (git(['rev-parse', 'HEAD']) !== request.head || git(['status', '--porcelain']).length) throw new Error('Verification changed the pinned worktree; changes preserved for inspection');
} catch {
  // Do not put host paths or raw process diagnostics into shared state.
  for (let i = 0; i < request.commands.length; i++) checks[i] = { kind: 'deterministic', name: request.commands[i].name, result: 'fail', evidence: 'Verification environment invalidated; inspect local logs and reconcile the Task worktree' };
}
await publish(dir, 'result.json', { id: request.id, checks, verdict: checks.every(c => c.result === 'pass') ? 'pass' : 'fail' });
server.close();
