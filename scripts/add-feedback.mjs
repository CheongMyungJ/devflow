// 0단계 운영의 입구: 질문·실행 중 지시·요구사항·답 — commands.addFeedback (docs/design/commands.md 6.1·6.2·6.3).
// 사용: npm run add-feedback -- <data-dir> <task-id> --kind question|direction|requirement|answer --channel review|live|plan
//         [--step <step-id>] [--artifact-ref <ref>] [--location <text>] [--run R-NNN] [--decision D-NNN] (--text <text> | --text-file <file>) --actor human:<id>
// --artifact-ref 는 이 Task(--step 이 있으면 그 Step)의 것이고 그 이름의 가장 새 버전이어야 한다.
// approval 은 approve-step, revision_request 는 request-revision 이 쓴다(한 기록은 한 command). Step 의 status 는 바꾸지 않는다.
// 한 commit: Feedback, feedback.added(data.kind, data.channel). 거부되면 exit 1, 사용법 오류는 exit 2.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, parseEntryArgs, report, TEXT_OPTIONS, textFrom } from './lib/cli.mjs';

const USAGE =
  'usage: add-feedback <data-dir> <task-id> --kind <kind> --channel <channel> [--step <step-id>] [--artifact-ref <ref>] [--location <text>] [--run R-NNN] [--decision D-NNN] (--text <text> | --text-file <file>) --actor human:<id>';
const V = { value: true };
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId'],
  human: true,
  options: { kind: { value: true, required: true }, channel: { value: true, required: true }, step: V, 'artifact-ref': V, location: V, run: V, decision: V, ...TEXT_OPTIONS },
});
const text = textFrom(opts, USAGE);
const given = { artifactRef: opts['artifact-ref'], location: opts.location, runId: opts.run, decisionId: opts.decision };
const target = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { feedback, result } = await commands.addFeedback(ctx, {
    taskId: args.taskId,
    stepId: opts.step,
    kind: opts.kind,
    channel: opts.channel,
    target: Object.keys(target).length ? target : undefined,
    text,
  });
  return `recorded ${feedback.id} (${feedback.kind}) on ${args.taskId}${feedback.step_id ? `/${feedback.step_id}` : ''}; ${committed(result)}`;
});
