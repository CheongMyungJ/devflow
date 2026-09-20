import { assemble } from './lib/assemble.mjs';
import { checkTaskId, parseEntryArgs, readStructured, report } from './lib/cli.mjs';

const USAGE = 'usage: submit-worker <data-dir> <task-id> <step-id> <run-id> <input-file> --runner-dir <dir> [--backend fake|claude-code|codex|opencode] [--machine-config <file>]';
const { args, opts } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE, positional: ['dataDir', 'taskId', 'stepId', 'runId', 'inputFile'],
  options: { backend: { value: true }, 'runner-dir': { value: true, required: true }, 'machine-config': { value: true } },
});
const input = readStructured(args.inputFile, 'execution input').value;
await report(async () => {
  const { commands, ctx } = await assemble({ dataDir: args.dataDir, machineConfig: opts['machine-config'], runnerDir: opts['runner-dir'], backend: opts.backend });
  checkTaskId(commands, args.taskId, USAGE);
  return JSON.stringify(await commands.submitWorker(ctx, { taskId: args.taskId, stepId: args.stepId, runId: args.runId, input }), null, 2);
});
