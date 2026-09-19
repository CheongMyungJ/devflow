// devflow-data 의 Task 디렉터리를 스키마로 검사한다.
// 0단계(수동 운영)에서 손으로 쓴 데이터를 확인하는 용도. 사용: npm run validate-data -- <data-dir> [T-0001 ...]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadSchemas } from '../src/schema/registry.mjs';

// 스키마는 모두 한 ajv 에 등록한다 — 스키마가 파일을 가로질러 $ref 한다(decision → step).
const { validator } = loadSchemas(join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas'));

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
// 이름이 그 kind 의 모양인 파일만 그 kind 로 읽는다 — Store 의 list 와 같은 규칙이다(docs/design/store.md 3.1, src/store/file/layout.ts).
// runs/ 에는 Run 기록(R-NNN.yaml) 말고도 그 Run 이 소유한 파일(R-NNN.output.yaml, R-NNN.work-notes.md 등 — blob)이 있고, gates/ 에는
// Gate 가 소유한 파일(G-NNN.deterministic.md 등)이 있다. blob 가운데에는 이름이 .yaml 로 끝나는 것도 있다(R-NNN.output.yaml).
// Task 수준과 Step 수준 모두 같다. 이 규칙과 Store 의 list 가 같은 파일을 읽는지는 tests/store/list-rules.test.ts 가 확인한다.
const decisionFiles = (dir) => yamlFiles(dir).filter((n) => /^D-\d+\.yaml$/.test(n));
const feedbackFiles = (dir) => yamlFiles(dir).filter((n) => /^F-\d+\.yaml$/.test(n));
const runFiles = (dir) => yamlFiles(dir).filter((n) => /^R-\d+\.yaml$/.test(n));
const gateFiles = (dir) => yamlFiles(dir).filter((n) => /^G-\d+\.yaml$/.test(n));
// Artifact meta: steps/<step>/artifacts/<name>/v<N>.meta.yaml (docs/design/store.md 3.1)
const metaFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^v\d+\.meta\.yaml$/.test(f)) : []);
const readYaml = (file) => parse(readFileSync(file, 'utf8'));

const taskIds = only.length ? only : readdirSync(dataDir).filter((d) => /^T-\d+$/.test(d));
for (const taskId of taskIds) {
  const dir = join(dataDir, taskId);
  check('task', readYaml(join(dir, 'task.yaml')), `${taskId}/task.yaml`);

  for (const f of decisionFiles(join(dir, 'decisions'))) check('decision', readYaml(join(dir, 'decisions', f)), `${taskId}/decisions/${f}`);

  // Task 수준의 Feedback·Run (Step 에 속하지 않는 것 — docs/design/store.md 5절 F4, F7)
  for (const f of feedbackFiles(join(dir, 'feedback'))) check('feedback', readYaml(join(dir, 'feedback', f)), `${taskId}/feedback/${f}`);
  for (const f of runFiles(join(dir, 'runs'))) check('run', readYaml(join(dir, 'runs', f)), `${taskId}/runs/${f}`);

  const stepsDir = join(dir, 'steps');
  for (const step of existsSync(stepsDir) ? readdirSync(stepsDir) : []) {
    const sdir = join(stepsDir, step);
    check('step', readYaml(join(sdir, 'step.yaml')), `${taskId}/steps/${step}/step.yaml`);
    for (const f of feedbackFiles(join(sdir, 'feedback'))) check('feedback', readYaml(join(sdir, 'feedback', f)), `${taskId}/steps/${step}/feedback/${f}`);
    for (const f of gateFiles(join(sdir, 'gates'))) check('gate-result', readYaml(join(sdir, 'gates', f)), `${taskId}/steps/${step}/gates/${f}`);
    for (const f of runFiles(join(sdir, 'runs'))) check('run', readYaml(join(sdir, 'runs', f)), `${taskId}/steps/${step}/runs/${f}`);
    const artifactsDir = join(sdir, 'artifacts');
    for (const name of existsSync(artifactsDir) ? readdirSync(artifactsDir) : []) {
      for (const f of metaFiles(join(artifactsDir, name)))
        check('artifact', readYaml(join(artifactsDir, name, f)), `${taskId}/steps/${step}/artifacts/${name}/${f}`);
    }
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
