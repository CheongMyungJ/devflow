// 0단계 운영의 입구: 다른 command 가 쓰지 않는 이벤트(ledger.updated 등)를 appendEvents 로 Store 의 commit 에 기록한다
// (docs/design/commands.md 6.1~6.3). 모든 이벤트에 commit_id 가 붙는다.
// 사용: npm run append-events -- <data-dir> <task-id> <events.json> [--actor human:<id>]
//   events.json 은 { type, step_id?, run_id?, ref?, data? } 의 배열이다. actor·at·system_sha·seq·task_id·commit_id 는 도구가 채운다 —
//   입력에 있으면 거부한다. actor 는 --actor 가 없으면 system 이다.
//   받는 type: ledger.updated, run.message_sent, decision.answered, task.requirement_added (done·aborted 인 Task 에는 ledger.updated 만).
// 거부되면 아무것도 쓰지 않고 exit 1, 사용법 오류는 exit 2. ledger.md 는 쓰지 않는다 — Ledger 는 편집 도구로 고치고 이것으로 ledger.updated 를 남긴다.
import { readFileSync } from 'node:fs';
import { assemble } from './lib/assemble.mjs';

const USAGE = 'usage: append-events <data-dir> <task-id> <events.json> [--actor human:<id>]';
function usage(message) {
  console.error(message ? `${message}\n${USAGE}` : USAGE);
  process.exit(2);
}

const positional = [];
let actor = 'system';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--actor') {
    actor = argv[++i] ?? '';
    if (!/^human:\S/.test(actor)) usage('--actor 는 human:<id> 모양이다');
  } else if (argv[i].startsWith('--')) usage(`모르는 옵션 ${argv[i]}`);
  else positional.push(argv[i]);
}
if (positional.length === 2) usage('옛 인자 모양(<task-dir> <events.json>)은 받지 않는다 — <data-dir> <task-id> <events.json> 로 준다');
if (positional.length !== 3) usage();
const [dataDir, taskId, eventsFile] = positional;
if (!/^T-\d{4,}$/.test(taskId)) usage(`<task-id> 가 T-NNNN 모양이 아니다: ${taskId}`);

let events;
try {
  events = JSON.parse(readFileSync(eventsFile, 'utf8'));
} catch (error) {
  console.error(`events.json 을 읽지 못했다: ${error.message}`);
  process.exit(1);
}

const { commands, ctx } = await assemble({ dataDir, actor });
try {
  const written = await commands.appendEvents(ctx, { taskId, events });
  const seqs = written.map((e) => e.seq);
  console.log(`appended ${written.length} events to ${taskId}, seq ${seqs[0]}..${seqs.at(-1)}, commit ${written[0].commit_id}`);
} catch (error) {
  if (error?.name === 'RejectedInputError') {
    console.error('rejected — 아무것도 기록하지 않았다:');
    for (const reason of error.reasons) console.error(`  ${reason}`);
  } else if (error?.name === 'CommitOutcomeUnknownError') {
    console.error(`${error.message} — 기록되었는지 확인하지 못했다. events.jsonl 에서 commit ${error.commitId} 를 찾아 확인하라`);
  } else console.error(`${error?.name ?? 'Error'}: ${error?.message ?? error} — 아무것도 기록하지 않았다`);
  process.exit(1);
}
