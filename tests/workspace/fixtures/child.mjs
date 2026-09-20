import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const input = JSON.parse(process.argv[2]);
const load = (path) => import(pathToFileURL(join(input.build, path)).href);
const { FileStore } = await load('src/store/file/index.js');
const { GitWorkspace } = await load('src/workspace/git/workspace.js');
const { prepareWorkspace } = await load('src/commands/workspace.js');
const workspace = new GitWorkspace({
  remoteUrl: async () => input.remote,
  locate: async () => ({ url: input.remote, clone: input.clone, worktreeRoot: input.worktreeRoot, remote: 'origin' }),
});
const halt = async () => {
  setInterval(() => {}, 1000);
  process.stdout.write('checkpoint\n');
  await new Promise(() => {});
};
const ensure = workspace.ensure.bind(workspace);
workspace.ensure = async (preparation) => {
  if (input.crashAt === 'intent') await halt();
  const result = await ensure(preparation);
  if (input.crashAt === 'git') await halt();
  return result;
};
try {
  await prepareWorkspace({ store: new FileStore({ dataDir: input.dataDir }), workspace, actor: 'system', clock: { now: () => new Date() } }, { taskId: input.taskId });
  if (input.crashAt === 'complete') await halt();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
