import { assemble } from './lib/assemble.mjs';
import { checkTaskId, parseEntryArgs, report } from './lib/cli.mjs';

const USAGE = 'usage: prepare-workspace <data-dir> <task-id> [--machine-config <file>]';
const { args, opts } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE, positional: ['dataDir', 'taskId'], options: { 'machine-config': { value: true } },
});
await report(async () => {
  const { commands, ctx } = await assemble({ dataDir: args.dataDir, machineConfig: opts['machine-config'] });
  checkTaskId(commands, args.taskId, USAGE);
  const result = await commands.prepareWorkspace(ctx, { taskId: args.taskId });
  return [`prepared ${args.taskId} (${result.preparation.base_source}:${result.preparation.base_branch}@${result.preparation.base_sha})`,
    `workdir: ${result.location.workdir}`, `HEAD: ${result.location.head}${result.location.dirty ? ' (uncommitted changes preserved)' : ''}`];
});
