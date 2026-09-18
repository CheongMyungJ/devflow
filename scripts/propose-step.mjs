// 0단계 수동 운영용: next_step Decision 의 Step 제안으로 steps/<step-id>/step.yaml 을 만든다 (status: proposed).
// 사용: npm run propose-step -- <data-dir>/<task-id> <decision-id> <step-id>
// Decision 은 Planner 의 원래 제안으로 남고, 사람의 수정은 step.yaml 에만 반영한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse, stringify } from 'yaml';

const [taskDir, decisionId, stepId] = process.argv.slice(2);
if (!taskDir || !decisionId || !stepId) {
  console.error('usage: propose-step <task-dir> <decision-id> <step-id>');
  process.exit(2);
}
const decision = parse(readFileSync(join(taskDir, 'decisions', `${decisionId}.yaml`), 'utf8'));
if (decision.action !== 'next_step' || !decision.next_step?.step) throw new Error(`${decisionId} is not a freeform next_step decision`);
const dir = join(taskDir, 'steps', stepId);
const file = join(dir, 'step.yaml');
if (existsSync(file)) throw new Error(`${file} already exists`);
mkdirSync(dir, { recursive: true });
const step = { id: stepId, task_id: basename(taskDir), ...decision.next_step.step, status: 'proposed' };
writeFileSync(file, stringify(step, { lineWidth: 0 }));
console.log(`wrote ${stepId}/step.yaml (proposed) from ${decisionId}`);
