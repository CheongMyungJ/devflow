// 0단계 운영의 입구: Task done — commands.completeTask (docs/design/commands.md 6.1·6.2·6.3).
// 사용: npm run complete-task -- <data-dir> <task-id> --decision D-NNN --merge-sha <sha> [--merge-method <text>] --post-merge-check <text> [--note <text>] --actor human:<id>
//   --decision: 사람이 확정한 Planner 의 done Decision. --merge-sha: task branch 를 합친 commit(줄이지 않은 40자 또는 64자 16진 소문자).
//   merge 의 repo·branch 는 Task 의 target(repo, base_branch)에서 도구가 채운다. --post-merge-check: merge 뒤에 확인한 것(비울 수 없다).
// 한 commit: task.yaml(status done)과 task.done(ref 와 data.confirmed 는 그 Decision, data.merge, data.post_merge_check, data.note).
// system_sha 는 이 입구를 부른 devflow 의 HEAD 다 — merge 뒤의 main 에서 부른다. Ledger 는 쓰지 않는다.
// 거부(Task 가 open 이 아니다, Decision 이 done 이 아니다, 닫히지 않은 Step 이 있다 등)되면 exit 1, 사용법 오류는 exit 2.
import { assemble } from './lib/assemble.mjs';
import { checkTaskId, committed, parseEntryArgs, report } from './lib/cli.mjs';

const USAGE =
  'usage: complete-task <data-dir> <task-id> --decision D-NNN --merge-sha <sha> [--merge-method <text>] --post-merge-check <text> [--note <text>] --actor human:<id>';
const { args, opts, actor } = parseEntryArgs(process.argv.slice(2), {
  usage: USAGE,
  positional: ['dataDir', 'taskId'],
  human: true,
  options: {
    decision: { value: true, required: true },
    'merge-sha': { value: true, required: true },
    'merge-method': { value: true },
    'post-merge-check': { value: true, required: true },
    note: { value: true },
  },
});

const { commands, ctx } = await assemble({ dataDir: args.dataDir, actor });
checkTaskId(commands, args.taskId, USAGE);
await report(async () => {
  const { task, result } = await commands.completeTask(ctx, {
    taskId: args.taskId,
    decisionId: opts.decision,
    merge: { sha: opts['merge-sha'], ...(opts['merge-method'] !== undefined ? { method: opts['merge-method'] } : {}) },
    postMergeCheck: opts['post-merge-check'],
    note: opts.note,
  });
  return `${task.id} done (confirmed ${opts.decision}, merge ${opts['merge-sha'].slice(0, 7)}); ${committed(result)}`;
});
