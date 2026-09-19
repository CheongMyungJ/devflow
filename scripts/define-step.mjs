// 0단계 운영의 입구: 사람의 Step 확정 — commands.defineStep (docs/design/commands.md 6.1·6.2·6.3, 7절).
// 사용: npm run define-step -- <data-dir> <task-id> <step-id> [--edited <step-definition.yaml>] [--note <text>] --actor human:<id>
//   --edited: 사람이 고친 Step 정의(id·task_id·status·created_from 없이). 없으면 제안 그대로 확정한다.
// 한 commit: step.yaml(defined, 고친 정의의 반영), step.defined(data.human_edit — 도구가 created_from Decision 의 제안과 비교해 채운다, data.note),
// step.status_changed(proposed → defined). --actor 가 없으면 사용법 오류(exit 2). 거부되면 exit 1 — 아무것도 쓰지 않았다.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, parseEntryArgs, readStructured, report } from './lib/cli.mjs';

const USAGE = 'usage: define-step <data-dir> <task-id> <step-id> [--edited <step-definition.yaml>] [--note <text>] --actor human:<id>';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId', 'stepId'],
  human: true,
  options: { edited: { value: true }, note: { value: true } },
});
const definition = opts.edited !== undefined ? readStructured(opts.edited, '--edited').value : undefined;

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { step, humanEdit, result } = await commands.defineStep(ctx, { taskId: args.taskId, stepId: args.stepId, definition, note: opts.note });
  return `defined ${step.id} on ${args.taskId} (human_edit ${humanEdit}); ${committed(result)}`;
});
