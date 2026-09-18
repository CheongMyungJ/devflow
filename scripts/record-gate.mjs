// 0단계 수동 운영용: Reviewer 의 출력 파일(JSON)에 식별 필드를 채워 gates/<gate-id>.yaml 로 기록한다.
// 사용: npm run record-gate -- <data-dir>/<task-id> <step-id> <gate-id> <reviewer-run-id> <artifact-ref>[,<artifact-ref>...]
// 출력 파일은 steps/<step-id>/runs/<reviewer-run-id>.output.json. 기록 뒤에 validate-data 로 스키마를 검사한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';

const [taskDir, stepId, gateId, runId, refs] = process.argv.slice(2);
if (!taskDir || !stepId || !gateId || !runId || !refs) {
  console.error('usage: record-gate <task-dir> <step-id> <gate-id> <reviewer-run-id> <artifact-ref>[,...]');
  process.exit(2);
}
const stepDir = join(taskDir, 'steps', stepId);
const out = JSON.parse(readFileSync(join(stepDir, 'runs', `${runId}.output.json`), 'utf8'));
const file = join(stepDir, 'gates', `${gateId}.yaml`);
if (existsSync(file)) throw new Error(`${file} already exists`);
mkdirSync(join(stepDir, 'gates'), { recursive: true });
const gate = {
  id: gateId,
  task_id: basename(taskDir),
  step_id: stepId,
  artifact_refs: refs.split(','),
  verdict: out.verdict,
  checks: out.checks,
  done_when: out.done_when,
  comments: out.comments,
  reviewer_run_id: runId,
  created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
};
writeFileSync(file, stringify(gate, { lineWidth: 0 }));
console.log(`wrote gates/${gateId}.yaml — verdict ${gate.verdict}, ${gate.checks?.length} checks, ${gate.comments?.length} comments`);
