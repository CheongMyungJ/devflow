// 0단계 운영의 입구: Planner 의 출력을 받아들인다 — commands.recordDecision (docs/design/commands.md 6.1·6.2·6.3, 7절). npm 명령 이름은 그대로다
// (뜻은 "Planner 의 출력을 받아들인다" — next_step 이면 Step 제안이 생긴다).
// 사용: npm run propose-step -- <data-dir> <task-id> <planner-run-id> <output.yaml> [--output-attempts <n>] [--note <text>]
//   <output.yaml>: Planner 의 출력 파일(Decision 모양, 데이터 디렉터리 밖 — T-0006 F-001 1-가). 원문은 blob R-NNN.output.yaml 로 남는다.
// 한 commit: Decision(id·task_id·planner_run_id·created_at 은 도구가 채운다 — Planner 가 적은 값은 원문에만 남는다), Planner Run(completed,
// packet_gaps ← Decision 의 packet_gaps), run.completed, decision.made, next_step 이면 step.yaml(proposed, created_from)과 step.proposed.
// proposed 로의 step.status_changed 는 쓰지 않는다(step.proposed 가 status 를 정한다). 닫히지 않은 Step 이 있으면 next_step 을 거부한다.
// 옛 모양(<task-dir> <decision-id> <step-id>)은 사용법 오류(exit 2). 거부되면 exit 1 — 아무것도 쓰지 않았다.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, intOption, parseEntryArgs, readStructured, report } from './lib/cli.mjs';

const USAGE = 'usage: propose-step <data-dir> <task-id> <planner-run-id> <output.yaml> [--output-attempts <n>] [--note <text>]';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId', 'runId', 'output'],
  oldShape: 3,
  options: { 'output-attempts': { value: true }, note: { value: true } },
});
const outputAttempts = intOption(opts['output-attempts'], 'output-attempts', USAGE);
const output = readStructured(args.output, '<output.yaml>');

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { decision, step, result } = await commands.recordDecision(ctx, { taskId: args.taskId, runId: args.runId, output: output.value, outputText: output.text, outputAttempts, note: opts.note });
  return `recorded ${decision.id} (${decision.action}) from ${args.runId}${step ? `, proposed ${step.id}` : ''}; ${committed(result)}`;
});
