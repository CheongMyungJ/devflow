// 0단계 운영의 입구: Worker 의 Run 을 완료로 기록한다 — commands.completeRun (docs/design/commands.md 6.1·6.2·6.3·6.4, 7절).
// 사용: npm run complete-run -- <data-dir> <task-id> <run-id> --worker-output <output.json> [--work-notes <notes.md>]
//         --artifact <name>=<source> [--artifact …] [--output-attempts <n>] [--note <text>]
//   <source>: code:<base-sha>..<head-sha> | repo:<base-sha>..<head-sha>:<path>[,<path>…] | blob:work-notes
// 역할 세션의 출력(worker-output JSON, 작업 노트)은 데이터 디렉터리 밖의 파일에서 받아 blob 으로 쓴다(T-0006 F-001 1-가·3-가). 받은 로컬 경로는 기록하지 않는다.
// 한 commit: Run(completed, packet_gaps ← worker-output), blob R-NNN.output.json·R-NNN.work-notes, Artifact meta 들, run.completed,
// artifact.version_added×N, step.yaml(running·revising → checking)과 step.status_changed. 거부되면 exit 1, 사용법 오류는 exit 2.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, intOption, parseEntryArgs, readText, report, usageExit } from './lib/cli.mjs';

const USAGE =
  'usage: complete-run <data-dir> <task-id> <run-id> --worker-output <json> [--work-notes <md>] --artifact <name>=<source> [--artifact …] [--output-attempts <n>] [--note <text>]';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId', 'runId'],
  options: {
    'worker-output': { value: true, required: true },
    'work-notes': { value: true },
    artifact: { value: true, repeat: true, required: true },
    'output-attempts': { value: true },
    note: { value: true },
  },
});
const artifacts = opts.artifact.map((a) => {
  const eq = a.indexOf('=');
  if (eq <= 0) usageExit(USAGE, `--artifact 는 <name>=<source> 모양이다: ${a}`);
  return { name: a.slice(0, eq), source: a.slice(eq + 1) };
});
const outputAttempts = intOption(opts['output-attempts'], 'output-attempts', USAGE);
const workerOutput = readText(opts['worker-output'], '--worker-output');
const workNotes = opts['work-notes'] !== undefined ? readText(opts['work-notes'], '--work-notes') : undefined;

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { artifacts: written, result } = await commands.completeRun(ctx, { taskId: args.taskId, runId: args.runId, workerOutput, workNotes, artifacts, outputAttempts, note: opts.note });
  return [`completed ${args.runId} on ${args.taskId}, ${committed(result)}`, ...written.map((a) => `  ${a.ref}`)];
});
