import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const options = JSON.parse(process.argv[2]);
const load = (path) => import(pathToFileURL(join(options.build, path)).href);
const { FileStore } = await load('src/store/file/index.js');
const { GitWorkspace } = await load('src/workspace/git/workspace.js');
const { FakeRunner } = await load('src/runner/fake/runner.js');
const { submitWorker, collectWorker } = await load('src/commands/worker.js');
const store = new FileStore({ dataDir: options.dataDir });
const classes = { 'claude-code': 'ClaudeCodeRunner', codex: 'CodexRunner', opencode: 'OpenCodeRunner' };
const Runner = options.backend ? (await load(`src/runner/${options.backend}/runner.js`))[classes[options.backend]] : FakeRunner;
const runner = new Runner(options.runnerDir, options.cli);
const workspace = new GitWorkspace({ remoteUrl: async () => options.remote,
  locate: async () => ({ url: options.remote, clone: options.clone, worktreeRoot: options.worktreeRoot, remote: 'origin' }) });
const ctx = { store, workspace, runner, actor: 'system', clock: { now: () => new Date() } };
async function checkpoint() {
  console.log('checkpoint');
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (options.phase === 'submitted') runner.submit = checkpoint;
if (options.phase === 'running') {
  const submit = runner.submit.bind(runner);
  runner.submit = async (request) => { await submit(request); await checkpoint(); };
}
if (options.phase === 'before-complete' || options.phase === 'after-complete') {
  const commit = store.commit.bind(store);
  store.commit = async (...args) => {
    if (options.phase === 'before-complete') await checkpoint();
    const result = await commit(...args);
    await checkpoint();
    return result;
  };
  await collectWorker(ctx, { taskId: options.input.taskId, runId: options.input.runId });
} else await submitWorker(ctx, options.input);
