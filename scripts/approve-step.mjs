// 0단계 운영의 입구: 승인 — commands.approveStep (docs/design/commands.md 6.1·6.2·6.3, 7절).
// 사용: npm run approve-step -- <data-dir> <task-id> <step-id> --gate G-NNN (--text <text> | --text-file <file>) --actor human:<id>
//   --gate: 사람이 본 Gate(필수 — T-0006 F-001 (2)). 그 Gate 가 이 Step 의 pass 이고, 그 artifact_refs 가 outputs 이름마다 하나씩이며 각각이
//   그 이름의 가장 새 버전일 때만 그 버전들을 승인한다. 사람이 본 뒤에 새 버전이 생겼으면 거부한다.
// 한 commit: 산출물마다 승인 Feedback, step.yaml(closed), feedback.added×N, artifact.approved×N(data.gate), step.status_changed
// in_review → approved(data.official_gate) → closed. Ledger 는 쓰지 않는다 — Ledger 요약은 편집 도구로 쓰고 ledger.updated 는 append-events 로.
// 거부되면 exit 1, 사용법 오류는 exit 2.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, parseEntryArgs, report, TEXT_OPTIONS, textFrom } from './lib/cli.mjs';

const USAGE = 'usage: approve-step <data-dir> <task-id> <step-id> --gate G-NNN (--text <text> | --text-file <file>) --actor human:<id>';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId', 'stepId'],
  human: true,
  options: { gate: { value: true, required: true }, ...TEXT_OPTIONS },
});
const text = textFrom(opts, USAGE);

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { approved, result } = await commands.approveStep(ctx, { taskId: args.taskId, stepId: args.stepId, gateId: opts.gate, text });
  return [`approved and closed ${args.taskId}/${args.stepId} with ${opts.gate}; ${committed(result)}`, ...approved.map((ref) => `  ${ref}`)];
});
