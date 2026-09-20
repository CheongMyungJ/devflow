// Opt-in real CLI smoke. Never called by npm test. Only claude-code/codex are accepted.
// Keeps its isolated temp repository/data/evidence for inspection; never touches devflow-data.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepareBuild } from '../../scripts/lib/build.mjs';

const backend = process.argv[2];
if (!['claude-code', 'codex'].includes(backend)) throw new Error('Only explicitly requested claude-code/codex real smoke is supported; no OpenCode model calls');
const { dir: build } = prepareBuild();
const load = path => import(pathToFileURL(join(build, path)).href);
const commands = await load('src/commands/index.js');
const { FileStore } = await load('src/store/file/index.js');
const { GitWorkspace } = await load('src/workspace/git/workspace.js');
const { getWorkerExecution } = await load('src/queries/worker.js');
const { executionKey } = await load('src/runner/records.js');
const { loadSchemas } = await load('src/schema/registry.mjs');
const Adapter = (await load(`src/runner/${backend}/runner.js`))[backend === 'codex' ? 'CodexRunner' : 'ClaudeCodeRunner'];
const root = mkdtempSync(join(tmpdir(), `devflow-real-${backend}-`));
const clone = join(root, 'clone'); const remote = join(root, 'remote.git'); const worktreeRoot = join(root, 'worktrees');
const dataDir = join(root, 'test-data'); const runnerDir = join(root, 'runner');
console.log(JSON.stringify({ backend, root, stage: 'setup' }));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(root, 'init', '--bare', '--initial-branch=trunk', remote);
mkdirSync(clone); git(clone, 'init', '--initial-branch=trunk');
git(clone, 'config', 'user.name', 'devflow smoke'); git(clone, 'config', 'user.email', 'smoke@example.invalid');
git(clone, 'remote', 'add', 'origin', remote);
writeFileSync(join(clone, 'README.md'), 'Isolated devflow Runner smoke repository.\n');
git(clone, 'add', 'README.md'); git(clone, 'commit', '-m', 'smoke baseline');
const catalog = { remoteUrl: async () => remote, locate: async () => ({ url: remote, clone, worktreeRoot, remote: 'origin' }) };
let ctx = { store: new FileStore({ dataDir }), workspace: new GitWorkspace(catalog), runner: new Adapter(runnerDir),
  actor: 'human:smoke', clock: { now: () => new Date() } };
const task = await commands.createTask(ctx, { title: 'Real Worker smoke', type: 'feature', goal: 'Create a small verifiable file',
  acceptance_criteria: [{ id: 'AC1', text: 'File and role output match' }], target: { repo: 'smoke', base_branch: 'trunk', base_source: 'local' } });
const prepared = await commands.prepareWorkspace(ctx, { taskId: task.id });
// Fixture setup only. Runtime execution goes through commands/queries.
await ctx.store.commit(task.id, { writes: [{ kind: 'step', value: {
  id: 'step-001', task_id: task.id, status: 'defined', skill: null, goal: 'Write smoke file and report',
  scope: { include: ['smoke.txt'] }, inputs: ['task.brief'], outputs: [{ name: 'report', type: 'document' }],
  done_when: ['smoke.txt contains the exact text'], verify: { semantic: ['inspect smoke.txt'] }, approval: 'required',
} }], events: [{ type: 'step.defined', actor: 'system', at: new Date().toISOString(), step_id: 'step-001' }] });
const input = { taskId: task.id, stepId: 'step-001', runId: 'R-001', input: {
  backend, ...(backend === 'claude-code' ? { model: 'sonnet' } : {}),
  prompt: 'This is an isolated integration test. In the CURRENT working directory create smoke.txt containing exactly devflow runner smoke OK followed by one newline. Use file editing tools. Do not commit, install, access the network, spawn other agents, or touch other files. Then write the required role output file with summary "smoke completed", packet_gaps [], and work_notes "Created smoke.txt with the requested content.". Do not put any absolute paths in that report.',
  artifacts: [{ name: 'report', source: 'blob:work-notes' }],
} };
const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/caller.mjs', import.meta.url)), JSON.stringify({
  build, dataDir, runnerDir, clone, remote, worktreeRoot, backend, input, phase: 'running',
})], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
let stderr = ''; child.stderr.on('data', part => { stderr += part; });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('caller did not acknowledge submission')), 20000);
  child.stdout.on('data', part => { if (String(part).includes('checkpoint')) { clearTimeout(timer); resolve(); } });
  child.once('exit', () => { clearTimeout(timer); reject(new Error(`caller exited early: ${stderr}`)); });
});
const first = await getWorkerExecution(ctx, input); const key = executionKey(first.run);
const evidence = join(runnerDir, key.taskId, key.runId, key.executionId);
const deadline = Date.now() + 240000;
while (!existsSync(join(evidence, 'process.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
assert.equal((await getWorkerExecution(ctx, input)).execution.state, 'running', 'must terminate caller during actual execution');
assert.equal(JSON.parse(readFileSync(join(evidence, 'process.json'), 'utf8')).cwd, prepared.location.workdir);
child.kill('SIGKILL'); await exited;
ctx = { ...ctx, store: new FileStore({ dataDir }), runner: new Adapter(runnerDir) };
const afterKill = await getWorkerExecution(ctx, input);
assert.equal(afterKill.execution.state, 'running');
assert.deepEqual((await commands.submitWorker(ctx, input)).run.execution, first.run.execution);
console.log(JSON.stringify({ backend, stage: 'caller-killed', executionId: key.executionId }));
let observed;
do {
  observed = await getWorkerExecution(ctx, input);
  if (['completed', 'failed'].includes(observed.execution.state)) break;
  if (Date.now() > deadline) throw new Error(`timeout; retained evidence: ${evidence}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
} while (true);
const collected = await commands.collectWorker(ctx, { taskId: task.id, runId: 'R-001' });
const result = { backend, backendVersion: first.run.backend_version, model: first.run.model ?? 'CLI default (not inferred)',
  root, executionId: key.executionId, callerKilledWhileRunning: true, state: observed.execution,
  runStatus: collected.run.status, artifacts: collected.artifacts ?? [] };
writeFileSync(join(root, 'verification.json'), JSON.stringify(result, null, 2));
assert.equal(collected.run.status, 'completed', `real CLI failed; inspect ${join(root, 'verification.json')} and local logs`);
assert.equal(readFileSync(join(prepared.location.workdir, 'smoke.txt'), 'utf8'), 'devflow runner smoke OK\n');
assert.equal(loadSchemas().validator('worker-output')(JSON.parse(observed.execution.workerOutput)), true);
const events = await ctx.store.readEvents(task.id);
await commands.collectWorker(ctx, { taskId: task.id, runId: 'R-001' });
assert.deepEqual(await ctx.store.readEvents(task.id), events);
assert.equal(events.filter(e => e.type === 'run.completed').length, 1);
assert.equal(events.filter(e => e.type === 'artifact.version_added').length, 1);
assert.equal(collected.artifacts.length, 1);
console.log(JSON.stringify({ backend, stage: 'verified', root, backendVersion: result.backendVersion, events: events.length, artifacts: 1 }));

// Optional new read-role smoke verifies the same adapter's restricted output-file access.
if (process.argv.includes('--reviewer')) {
  const review = await commands.submitRole(ctx, { taskId: task.id, stepId: 'step-001', runId: 'R-002', role: 'reviewer', input: {
    backend, ...(backend === 'claude-code' ? { model: 'sonnet' } : {}), timeout_seconds: 120,
    prompt: 'Isolated read-only integration test. Read smoke.txt in the current workspace and verify it contains exactly devflow runner smoke OK followed by a newline. Do not change workspace files, run commands, install, access the network or spawn agents. Write only the designated JSON output file. If correct, verdict pass; include a semantic check named smoke-content with result pass, done_when [{condition:"smoke.txt contains the exact text",met:true}], comments [], packet_gaps [].',
    artifact_refs: collected.artifacts.map(a => a.ref),
  } });
  const reviewKey = executionKey(review.run), reviewDeadline = Date.now() + 150000;
  let state;
  do {
    state = await ctx.runner.inspect(reviewKey);
    if (['completed', 'failed'].includes(state.state)) break;
    if (Date.now() > reviewDeadline) throw new Error(`Reviewer timeout; inspect ${root}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (true);
  const done = await commands.collectExecution(ctx, { taskId: task.id, runId: 'R-002' });
  writeFileSync(join(root, 'reviewer-verification.json'), JSON.stringify({ backend, state, status: done.run.status }, null, 2));
  assert.equal(done.run.status, 'completed', `Reviewer failed; inspect ${root}`);
  assert.equal(readFileSync(join(prepared.location.workdir, 'smoke.txt'), 'utf8'), 'devflow runner smoke OK\n');
  console.log(JSON.stringify({ backend, stage: 'reviewer-verified', root, status: done.run.status }));
}
