import { assemble } from './lib/assemble.mjs';
import { checkTaskId, parseEntryArgs, report } from './lib/cli.mjs';

const USAGE = 'usage: collect-worker <data-dir> <task-id> <run-id> --runner-dir <dir> [--backend fake|claude-code|codex|opencode]';
const { args, opts } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE, positional: ['dataDir', 'taskId', 'runId'], options: { backend: { value: true }, 'runner-dir': { value: true, required: true } },
});
await report(async () => {
  const { commands, ctx } = await assemble({ dataDir: args.dataDir, runnerDir: opts['runner-dir'], backend: opts.backend });
  checkTaskId(commands, args.taskId, USAGE);
  return JSON.stringify(await commands.collectWorker(ctx, { taskId: args.taskId, runId: args.runId }), null, 2);
});
