// 0단계 수동 운영용: Task 의 events.jsonl 에 이벤트를 append 한다. seq 와 task_id 는 여기서 부여한다.
// 사용: npm run append-events -- <data-dir>/<task-id> <events.json>
//   events.json 은 { type, actor, at, step_id?, run_id?, ref?, data?, system_sha? } 의 배열이다.
// append 뒤에는 반드시 `npm run validate-data -- <data-dir>` 를 돌리고, 통과한 뒤에만 commit 한다.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [taskDir, inputFile] = process.argv.slice(2);
if (!taskDir || !inputFile) {
  console.error('usage: append-events <task-dir> <events.json>');
  process.exit(2);
}
const taskId = basename(taskDir);
const file = join(taskDir, 'events.jsonl');
// 새 Task 에는 events.jsonl 이 아직 없다. 없거나 비어 있으면 seq 1 부터 시작한다.
const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
if (existing && !existing.endsWith('\n')) throw new Error('events.jsonl does not end with a newline');
let seq = existing.split('\n').filter((l) => l.trim()).length;
const lines = JSON.parse(readFileSync(inputFile, 'utf8')).map((e) => {
  const { type, actor, step_id, run_id, ref, data, system_sha, at } = e;
  return JSON.stringify({ seq: ++seq, task_id: taskId, type, actor, step_id, run_id, ref, data, system_sha, at });
});
appendFileSync(file, lines.join('\n') + '\n');
console.log(`appended ${lines.length} events, last seq ${seq}`);
