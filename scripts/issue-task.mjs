// 0단계 운영의 입구: Task 발행 — commands.createTask (docs/design/commands.md 6.1·6.2·6.3).
// 사용: npm run issue-task -- <data-dir> <definition.yaml> [--slug <text>] [--backlog <text>] [--intake <text>] [--note <text>] --actor human:<id>
//   <definition.yaml>: 사람이 쓴 Task 정의(YAML). id·status·created_at·created_by·target.task_branch 는 도구가 채우므로 두지 않는다 — 있으면 거부.
//   사람이 답할 질문이 남은 정의(open_questions[].answered_by 가 planner_or_worker·investigation_step 밖)는 Task 스키마가 거부하고 위치를 보인다.
//   --slug: task branch 이름 task/<id>-<slug> 의 뒷부분. --backlog·--intake·--note: task.created 의 data(발행의 출처, Intake 의 방식, 경위).
// 한 commit: task.yaml(open, created_at 은 초 단위 UTC, created_by 는 사람의 id), task.created(actor human:<id>). 정의 파일의 경로는 기록하지 않는다.
// 거부되면 exit 1, 사용법 오류는 exit 2 — 어느 쪽도 아무것도 쓰지 않았다.
import { assemble } from './lib/assemble.mjs';
import { parseEntryArgs, readStructured, report } from './lib/cli.mjs';

const USAGE = 'usage: issue-task <data-dir> <definition.yaml> [--slug <text>] [--backlog <text>] [--intake <text>] [--note <text>] --actor human:<id>';
const V = { value: true };
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'definition'],
  human: true,
  options: { slug: V, backlog: V, intake: V, note: V },
});
const { value } = readStructured(args.definition, '<definition.yaml>');
if (typeof value !== 'object' || value === null || Array.isArray(value)) {
  console.error('rejected — 아무것도 기록하지 않았다:\n  <definition.yaml>: Task 정의(매핑)가 아니다');
  process.exit(1);
}
// 입구의 옵션이 채우는 자리 — 정의 파일로는 받지 않는다(Task 스키마의 칸이 아니다).
const misplaced = ['branchSlug', 'createdData'].filter((k) => k in value);
if (misplaced.length) {
  console.error(`rejected — 아무것도 기록하지 않았다:\n${misplaced.map((k) => `  ${k}: Task 정의의 칸이 아니다 — --slug·--backlog·--intake·--note 로 준다`).join('\n')}`);
  process.exit(1);
}
const createdData = Object.fromEntries(['backlog', 'intake', 'note'].filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
await report(async () => {
  const task = await commands.createTask(ctx, {
    ...value,
    ...(opts.slug !== undefined ? { branchSlug: opts.slug } : {}),
    ...(Object.keys(createdData).length ? { createdData } : {}),
  });
  return `issued ${task.id} (${task.status}, branch ${task.target.task_branch}) by ${task.created_by} at ${task.created_at}`;
});
