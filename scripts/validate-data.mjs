// devflow-data 의 Task 디렉터리를 스키마로 검사한다.
// 0단계(수동 운영)에서 손으로 쓴 데이터를 확인하는 용도. 사용: npm run validate-data -- <data-dir> [T-0001 ...]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validators = {};
const validator = (name) =>
  (validators[name] ??= ajv.compile(JSON.parse(readFileSync(join(schemaDir, `${name}.schema.json`), 'utf8'))));

const [dataDir, ...only] = process.argv.slice(2);
if (!dataDir) {
  console.error('usage: validate-data <data-dir> [task-id ...]');
  process.exit(2);
}

let failures = 0;
let checked = 0;
function check(schema, value, label) {
  checked++;
  const validate = validator(schema);
  if (validate(value)) return;
  failures++;
  console.error(`FAIL ${label}`);
  for (const e of validate.errors) console.error(`     ${e.instancePath || '/'} ${e.message}`);
}
const yamlFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')) : []);
const readYaml = (file) => parse(readFileSync(file, 'utf8'));

const taskIds = only.length ? only : readdirSync(dataDir).filter((d) => /^T-\d+$/.test(d));
for (const taskId of taskIds) {
  const dir = join(dataDir, taskId);
  check('task', readYaml(join(dir, 'task.yaml')), `${taskId}/task.yaml`);

  for (const f of yamlFiles(join(dir, 'decisions'))) check('decision', readYaml(join(dir, 'decisions', f)), `${taskId}/decisions/${f}`);

  // Task 수준의 Feedback·Run (Step 에 속하지 않는 것 — docs/design/store.md 5절 F4, F7)
  for (const f of yamlFiles(join(dir, 'feedback'))) check('feedback', readYaml(join(dir, 'feedback', f)), `${taskId}/feedback/${f}`);
  for (const f of yamlFiles(join(dir, 'runs'))) check('run', readYaml(join(dir, 'runs', f)), `${taskId}/runs/${f}`);

  const stepsDir = join(dir, 'steps');
  for (const step of existsSync(stepsDir) ? readdirSync(stepsDir) : []) {
    const sdir = join(stepsDir, step);
    check('step', readYaml(join(sdir, 'step.yaml')), `${taskId}/steps/${step}/step.yaml`);
    for (const f of yamlFiles(join(sdir, 'feedback'))) check('feedback', readYaml(join(sdir, 'feedback', f)), `${taskId}/steps/${step}/feedback/${f}`);
    for (const f of yamlFiles(join(sdir, 'gates'))) check('gate-result', readYaml(join(sdir, 'gates', f)), `${taskId}/steps/${step}/gates/${f}`);
    for (const f of yamlFiles(join(sdir, 'runs'))) check('run', readYaml(join(sdir, 'runs', f)), `${taskId}/steps/${step}/runs/${f}`);
  }

  const eventsFile = join(dir, 'events.jsonl');
  if (existsSync(eventsFile)) {
    const lines = readFileSync(eventsFile, 'utf8').split('\n').filter((l) => l.trim());
    lines.forEach((line, i) => {
      const event = JSON.parse(line);
      check('event', event, `${taskId}/events.jsonl:${i + 1}`);
      if (event.seq !== i + 1 || event.task_id !== taskId) {
        failures++;
        console.error(`FAIL ${taskId}/events.jsonl:${i + 1} seq/task_id 불일치 (seq=${event.seq}, task_id=${event.task_id})`);
      }
    });
  }
}
console.log(`${checked} checked, ${failures} failed`);
process.exit(failures ? 1 : 0);
