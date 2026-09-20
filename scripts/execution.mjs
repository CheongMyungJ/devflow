import { assemble } from './lib/assemble.mjs';
import { parseEntryArgs, readStructured, report } from './lib/cli.mjs';

const USAGE = 'usage: execution <data-dir> <request-file> --runner-dir <dir> [--config <file>] [--project-config <file>] [--machine-config <file>] [--actor human:<id>]';
const { args, opts } = parseEntryArgs(process.argv.slice(2), { usage: USAGE, positional: ['dataDir', 'requestFile'],
  options: { 'runner-dir': { value: true, required: true }, config: { value: true }, 'project-config': { value: true }, 'machine-config': { value: true }, actor: { value: true } } });
const request = readStructured(args.requestFile, 'execution request').value;
await report(async () => {
  const { commands, ctx } = await assemble({ dataDir: args.dataDir, runnerDir: opts['runner-dir'], config: opts.config,
    projectConfig: opts['project-config'], machineConfig: opts['machine-config'], actor: opts.actor });
  return JSON.stringify(await commands.operateExecution(ctx, request), null, 2);
});
