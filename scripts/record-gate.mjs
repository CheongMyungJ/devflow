// 0단계 운영의 입구: Reviewer 의 출력을 받아들여 Gate 를 기록한다 — commands.recordGate (docs/design/commands.md 6.1·6.2·6.3·6.4, 7절). npm 명령 이름은 그대로다.
// 사용: npm run record-gate -- <data-dir> <task-id> <step-id> <gate-id> <reviewer-run-id> <artifact-ref>[,<artifact-ref>…]
//         --output <reviewer-output.json> [--annotations <file>] [--deterministic <file>] [--output-attempts <n>] [--note <text>]
//   --output: Reviewer 의 출력 파일(데이터 디렉터리 밖 — T-0006 F-001 1-가). blob R-NNN.output.json 으로 남는다.
//   --annotations: Reviewer 가 아닌 출처의 정보. JSON 또는 YAML 의 [{ source: system|worker, text, ref? }, …]. 빈 배열은 거부한다.
//   --deterministic: deterministic 검사의 결과 문서. Gate 와 같은 commit 에 blob G-NNN.deterministic 으로 쓴다(F-001 2-가).
// 쓰기 전에 하는 검증(하나라도 걸리면 exit 1 — 아무것도 쓰지 않았다. 옛 record-gate 의 1~5 를 command 가 한다):
//   1. Run 이 있고 reviewer 이며 이 Step 의 것이고 아직 submitted 다. gate id 는 G-NNN 의 정규형이고 다음에 발급될 id 와 같다(이미 있는 Gate 를 덮어쓰지 않는다).
//   2. 출력이 schemas/reviewer-output.schema.json 에 맞는다. 3. class A 가 있으면 verdict 는 fail.
//   4. 만들어질 Gate 가 schemas/gate-result.schema.json 에 맞는다. 5. 고쳐질 Run 이 Run 스키마에 맞는다(Store 가 쓰기 전에 검사).
//   그리고 artifact 참조마다 artifact://<task>/<step>/<name>@v<N> 이고(로컬 경로는 거부) 이 Step 의 것이며 있고 그 이름의 가장 새 버전이다.
//   Step 의 status 가 checking 이 아니면(허용 전이표) 거부.
// 한 commit: Gate, Reviewer Run(completed, packet_gaps ← 출력, output_attempts), blob 들, run.completed, gate.completed,
// step.yaml(pass → in_review, fail → revising)과 step.status_changed. 옛 입구의 "Run 만 고쳐진 채 죽는" 경우는 없다.
// 옛 모양(<task-dir> <step-id> …)은 사용법 오류(exit 2). 기록 뒤에 validate-data 로 데이터 디렉터리를 검사한다.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, intOption, parseEntryArgs, readStructured, readText, report } from './lib/cli.mjs';

const USAGE =
  'usage: record-gate <data-dir> <task-id> <step-id> <gate-id> <reviewer-run-id> <artifact-ref>[,…] --output <json> [--annotations <file>] [--deterministic <file>] [--output-attempts <n>] [--note <text>]';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId', 'stepId', 'gateId', 'runId', 'refs'],
  oldShape: 5,
  options: { output: { value: true, required: true }, annotations: { value: true }, deterministic: { value: true }, 'output-attempts': { value: true }, note: { value: true } },
});
const outputAttempts = intOption(opts['output-attempts'], 'output-attempts', USAGE);
const output = readText(opts.output, '--output');
const annotations = opts.annotations !== undefined ? readStructured(opts.annotations, '--annotations').value : undefined;
const deterministic = opts.deterministic !== undefined ? readText(opts.deterministic, '--deterministic') : undefined;

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { gate, result } = await commands.recordGate(ctx, {
    taskId: args.taskId,
    stepId: args.stepId,
    gateId: args.gateId,
    reviewerRunId: args.runId,
    artifactRefs: args.refs.split(','),
    output,
    annotations,
    deterministic,
    outputAttempts,
    note: opts.note,
  });
  return (
    `recorded ${gate.id} on ${args.taskId}/${args.stepId} — verdict ${gate.verdict}, ${gate.checks.length} checks, ${gate.comments?.length ?? 0} comments` +
    `${gate.annotations ? `, ${gate.annotations.length} annotations` : ''}; ${args.runId} completed; ${committed(result)}`
  );
});
