// 0단계 운영의 입구: Run 을 제출로 기록한다 — commands.submitRun (docs/design/commands.md 6.1·6.2·6.3, 7절).
// 사용: npm run submit-run -- <data-dir> <task-id> --role worker|reviewer|planner --access read|write --backend <name> --session-path new|resumed|resume_failed_new
//         [--step <step-id>] [--purpose <p>] [--backend-version <v>] [--model <m>] [--backend-session-id <id>] [--performer <p>]
//         [--resumed-from R-NNN] [--expect-id R-NNN] [--packet <packet.md>] [--note <text>]
// 한 commit: Run(submitted), blob R-NNN.packet(--packet 의 내용), run.submitted, worker 가 defined 에서 부르면 step.yaml(running)과 step.status_changed.
// Run id·submitted_at·status·system_sha 는 도구가 채운다(--expect-id 는 발급될 id 가 다르면 거부). role intake 는 받지 않는다.
// 거부되면 아무것도 쓰지 않고 exit 1, 사용법 오류는 exit 2.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, parseEntryArgs, readText, report } from './lib/cli.mjs';

const USAGE =
  'usage: submit-run <data-dir> <task-id> --role <role> --access <read|write> --backend <name> --session-path <path> [--step <step-id>] [--purpose <p>] ' +
  '[--backend-version <v>] [--model <m>] [--backend-session-id <id>] [--performer <p>] [--resumed-from R-NNN] [--expect-id R-NNN] [--packet <file>] [--note <text>]';
const V = { value: true };
const R = { value: true, required: true };
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId'],
  options: {
    role: R, access: R, backend: R, 'session-path': R, step: V, purpose: V, 'backend-version': V, model: V,
    'backend-session-id': V, performer: V, 'resumed-from': V, 'expect-id': V, packet: V, note: V,
  },
});
const packet = opts.packet !== undefined ? readText(opts.packet, '--packet') : undefined;

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { run, result } = await commands.submitRun(ctx, {
    taskId: args.taskId,
    stepId: opts.step,
    role: opts.role,
    purpose: opts.purpose,
    access: opts.access,
    backend: opts.backend,
    backendVersion: opts['backend-version'],
    model: opts.model,
    backendSessionId: opts['backend-session-id'],
    sessionPath: opts['session-path'],
    performer: opts.performer,
    resumedFrom: opts['resumed-from'],
    expectId: opts['expect-id'],
    packet,
    note: opts.note,
  });
  return `submitted ${run.id} (${run.role}) on ${args.taskId}${run.step_id ? `/${run.step_id}` : ''}, ${committed(result)}`;
});
