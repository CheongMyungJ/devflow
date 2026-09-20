import { assemble } from './lib/assemble.mjs';
import { checkTaskId, parseEntryArgs, report } from './lib/cli.mjs';

const USAGE = 'usage: workspace-status <data-dir> <task-id> [--machine-config <file>]';
const { args, opts } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE, positional: ['dataDir', 'taskId'], options: { 'machine-config': { value: true } },
});
await report(async () => {
  const { commands, queries, ctx } = await assemble({ dataDir: args.dataDir, machineConfig: opts['machine-config'] });
  checkTaskId(commands, args.taskId, USAGE);
  const result = await queries.getWorkspace(ctx, args.taskId);
  return JSON.stringify(result, null, 2);
});
