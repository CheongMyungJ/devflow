// 0단계 운영의 입구: 끊긴 실행을 기록한다 — commands.failRun (docs/design/commands.md 6.1·6.2).
// 사용: npm run fail-run -- <data-dir> <task-id> <run-id> --reason <text> [--failed-notes <failed.md>] [--partial-diff <file>] [--note <text>]
// 한 commit: Run(failed, ended_at = 기록한 시각 — 실제로 끊긴 시각은 알 수 없다), blob R-NNN.failed·R-NNN.partial.diff, run.failed(data.reason, data.note).
// Step 의 status 는 바꾸지 않는다. 거부되면 exit 1, 사용법 오류는 exit 2.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, parseEntryArgs, readText, report } from './lib/cli.mjs';

const USAGE = 'usage: fail-run <data-dir> <task-id> <run-id> --reason <text> [--failed-notes <md>] [--partial-diff <file>] [--note <text>]';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId', 'runId'],
  options: { reason: { value: true, required: true }, 'failed-notes': { value: true }, 'partial-diff': { value: true }, note: { value: true } },
});
const failedNotes = opts['failed-notes'] !== undefined ? readText(opts['failed-notes'], '--failed-notes') : undefined;
const partialDiff = opts['partial-diff'] !== undefined ? readText(opts['partial-diff'], '--partial-diff') : undefined;

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { run, result } = await commands.failRun(ctx, { taskId: args.taskId, runId: args.runId, reason: opts.reason, note: opts.note, failedNotes, partialDiff });
  return `failed ${run.id} on ${args.taskId}, ${committed(result)}`;
});
