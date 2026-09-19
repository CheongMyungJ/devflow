// 0단계 운영의 입구: 사람의 수정 요청 — commands.requestRevision (docs/design/commands.md 6.1·6.2·6.3, 7절).
// 사용: npm run request-revision -- <data-dir> <task-id> <step-id> <artifact-ref> (--text <text> | --text-file <file>) --actor human:<id>
//   <artifact-ref>: 사람이 본 산출물의 버전 artifact://<task>/<step>/<name>@v<N> — 이 Step 의 것이고 그 이름의 가장 새 버전이어야 한다.
// 한 commit: Feedback(revision_request), feedback.added, step.yaml(in_review → revising)과 step.status_changed. 거부되면 exit 1, 사용법 오류는 exit 2.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, parseEntryArgs, report, TEXT_OPTIONS, textFrom } from './lib/cli.mjs';

const USAGE = 'usage: request-revision <data-dir> <task-id> <step-id> <artifact-ref> (--text <text> | --text-file <file>) --actor human:<id>';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), { usage: USAGE, positional: ['dataDir', 'taskId', 'stepId', 'artifactRef'], human: true, options: TEXT_OPTIONS });
const text = textFrom(opts, USAGE);

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { feedback, result } = await commands.requestRevision(ctx, { taskId: args.taskId, stepId: args.stepId, artifactRef: args.artifactRef, text });
  return `recorded ${feedback.id} (revision_request) on ${args.taskId}/${args.stepId}; ${committed(result)}`;
});
