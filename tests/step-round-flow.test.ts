// Step 한 바퀴의 흐름 (T-0006 step-004 ④, AC3·AC4 의 핵심): 임시 데이터 디렉터리에서 입구(자식 프로세스)만으로 한 바퀴 전체를 기록한다.
// Task 는 createTask 로 준비한다(Task 발행부터 done 까지 입구만으로 도는 흐름은 tests/task-flow.test.ts). 그 뒤로 손으로 쓴 yaml 이나 이벤트는 없다.
// 명령마다 확인한다: step.yaml 의 status = 그 Step 의 status 를 정한 마지막 이벤트(step.status_changed 의 to, 없으면 step.proposed 의 proposed),
// 새 이벤트 모두에 commit_id(명령 하나에 하나), 도구가 채운 초 단위 UTC 의 at, ref 는 isEventRef 의 모양. 끝에 validate-data 0 failed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createTask, isEventRef, systemClock } from '../src/commands/index.js';
import { allText, containsPath, entryRunner, validateData } from './entry-helpers.js';
import { newStore, tempDataDir } from './store/helpers.js';
import { stepDefinition } from './store/records.js';

const entry = entryRunner('flow');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECONDS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA = (c: string) => c.repeat(40);
type Json = Record<string, any>;

describe('Step 한 바퀴 — 입구만으로', () => {
  it('Planner → 제안 → 사람의 확정(수정) → Worker(실패·재실행) → Gate fail → 재작업 → Gate pass → 수정 요청 → 재작업 → Gate pass → 질문 → 승인 → closed', async () => {
    const dataDir = tempDataDir();
    const task = await createTask(
      { store: newStore(dataDir), clock: systemClock, actor: 'human:tester' },
      { title: '흐름', type: 'feature', goal: 'g', acceptance_criteria: [{ id: 'AC1', text: 't' }], target: { repo: 'example-project', base_branch: 'main' } },
    );
    const taskId = task.id;
    const taskDir = join(dataDir, taskId);
    const events = (): Json[] => readFileSync(join(taskDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json);
    const stepStatus = () => (parse(readFileSync(join(taskDir, 'steps', 'step-001', 'step.yaml'), 'utf8')) as Json).status as string;
    const log: string[] = [];

    /** 입구 하나를 돌리고 이 명령이 더한 이벤트를 검사한다. 돌려주는 것은 새 이벤트. */
    const run = (name: string, args: string[], expectStatus?: string): Json[] => {
      const before = events().length;
      const r = entry.run(name, [dataDir, taskId, ...args]);
      expect(r.status, `${name}\n${r.all}`).toBe(0);
      const added = events().slice(before);
      expect(added.length, name).toBeGreaterThan(0);
      // 모든 새 이벤트에 commit_id — 한 명령은 한 commit
      expect(added.every((e) => UUID.test(e.commit_id)), name).toBe(true);
      expect(new Set(added.map((e) => e.commit_id)).size, name).toBe(1);
      // 도구가 채운 초 단위 UTC 의 at, 방금의 시각
      for (const e of added) {
        expect(e.at, name).toMatch(SECONDS_UTC);
        expect(Math.abs(Date.now() - Date.parse(e.at)), name).toBeLessThan(120_000);
      }
      // command 가 채운 ref 도 appendEvents 의 입력과 같은 문법(F-003)
      for (const e of added) if (e.ref !== undefined) expect(isEventRef(e.ref), `${name} ref ${e.ref}`).toBe(true);
      // step.yaml 의 status = 그 Step 의 status 를 정한 마지막 이벤트
      const deciding = events().filter((e) => e.step_id === 'step-001' && (e.type === 'step.status_changed' || e.type === 'step.proposed'));
      if (deciding.length) {
        const last = deciding.at(-1)!;
        expect(stepStatus(), name).toBe(last.type === 'step.proposed' ? 'proposed' : last.data.to);
      }
      if (expectStatus !== undefined) expect(stepStatus(), name).toBe(expectStatus);
      log.push(`${name}: ${added.map((e) => e.type).join(', ')} → ${deciding.length ? stepStatus() : '-'}`);
      return added;
    };
    const file = (content: string, name: string) => entry.file(content, name);
    const workerOutput = (gaps: string[]) => file(JSON.stringify({ summary: '요약', packet_gaps: gaps }), 'worker-output.json');
    const reviewerOutput = (verdict: 'pass' | 'fail') =>
      file(
        JSON.stringify({
          verdict,
          checks: [{ kind: 'deterministic', name: 'test', result: verdict }],
          done_when: [{ condition: '예시 문서가 있다', met: verdict === 'pass' }],
          comments: verdict === 'fail' ? [{ severity: 'defect', class: 'A', text: '빠진 것' }] : [],
          packet_gaps: [],
        }),
        'reviewer-output.json',
      );
    const worker = ['--step', 'step-001', '--role', 'worker', '--access', 'write', '--backend', 'fake', '--session-path', 'new'];
    const reviewer = ['--step', 'step-001', '--role', 'reviewer', '--access', 'read', '--backend', 'fake', '--session-path', 'new'];
    const complete = (runId: string, head: string) => [
      runId, '--worker-output', workerOutput([`${runId} 의 부족`]), '--work-notes', file(`# ${runId} 노트\n`, 'notes.md'),
      '--artifact', 'plan=blob:work-notes', '--artifact', `change=code:${SHA('a')}..${head}`, '--output-attempts', '1',
    ];
    const refs = (v: number) => `artifact://${taskId}/step-001/plan@v${v},artifact://${taskId}/step-001/change@v${v}`;
    const human = ['--actor', 'human:tester'];

    // Planner
    run('submit-run', ['--role', 'planner', '--access', 'read', '--backend', 'fake', '--session-path', 'new', '--expect-id', 'R-001', '--packet', file('# 패킷\n', 'packet.md')]);
    const decision = stringify({ after_step: null, action: 'next_step', rationale: '첫 Step', next_step: { step: stepDefinition() }, packet_gaps: ['Planner 의 부족'] });
    expect(run('propose-step', ['R-001', file(decision, 'R-001.output.yaml')], 'proposed').map((e) => e.type)).toEqual(['run.completed', 'decision.made', 'step.proposed']);
    // 사람의 확정(수정 반영)
    const defined = run('define-step', ['step-001', '--edited', file(stringify({ ...stepDefinition(), goal: '사람이 고친 목표' }), 'edited.yaml'), ...human], 'defined');
    expect(defined[0]).toMatchObject({ type: 'step.defined', actor: 'human:tester', ref: 'D-001', data: { human_edit: true } });
    // Worker — 실패하고 다시
    run('submit-run', worker, 'running');
    expect(run('fail-run', ['R-002', '--reason', '끊겼다', '--partial-diff', file('diff\n', 'partial.diff')], 'running').map((e) => e.type)).toEqual(['run.failed']);
    expect(run('submit-run', worker, 'running').map((e) => e.type)).toEqual(['run.submitted']);
    run('complete-run', complete('R-003', SHA('b')), 'checking');
    // Reviewer → fail(deterministic 결과 포함) → 재작업
    run('submit-run', reviewer, 'checking');
    run('record-gate', ['step-001', 'G-001', 'R-004', refs(1), '--output', reviewerOutput('fail'), '--deterministic', file('# typecheck pass\n# test fail\n', 'det.md')], 'revising');
    expect(run('submit-run', worker, 'revising').map((e) => e.type)).toEqual(['run.submitted']);
    run('complete-run', complete('R-005', SHA('c')), 'checking');
    run('submit-run', reviewer, 'checking');
    run('record-gate', ['step-001', 'G-002', 'R-006', refs(2), '--output', reviewerOutput('pass')], 'in_review');
    // 사람의 수정 요청 → 재작업
    run('request-revision', ['step-001', `artifact://${taskId}/step-001/plan@v2`, '--text', '2절을 고쳐 주세요', ...human], 'revising');
    run('submit-run', worker, 'revising');
    run('complete-run', complete('R-007', SHA('d')), 'checking');
    run('submit-run', reviewer, 'checking');
    run('record-gate', ['step-001', 'G-003', 'R-008', refs(3), '--output', reviewerOutput('pass')], 'in_review');
    // 질문, 승인
    expect(run('add-feedback', ['--step', 'step-001', '--kind', 'question', '--channel', 'review', '--artifact-ref', `artifact://${taskId}/step-001/plan@v3`, '--text', '왜?', ...human], 'in_review').map((e) => e.type)).toEqual(['feedback.added']);
    const approved = run('approve-step', ['step-001', '--gate', 'G-003', '--text', '승인.', ...human], 'closed');
    expect(approved.map((e) => [e.type, e.ref ?? e.data])).toEqual([
      ['feedback.added', 'F-003'],
      ['feedback.added', 'F-004'],
      ['artifact.approved', `artifact://${taskId}/step-001/plan@v3`],
      ['artifact.approved', `artifact://${taskId}/step-001/change@v3`],
      ['step.status_changed', { from: 'in_review', to: 'approved', official_gate: 'G-003' }],
      ['step.status_changed', { from: 'approved', to: 'closed' }],
    ]);

    // 이 Step 의 전이 — 7절의 표에 있는 것만, 순서대로
    const transitions = events().filter((e) => e.type === 'step.status_changed').map((e) => `${e.data.from}→${e.data.to}`);
    expect(transitions).toEqual([
      'proposed→defined', 'defined→running', 'running→checking', 'checking→revising', 'revising→checking', 'checking→in_review',
      'in_review→revising', 'revising→checking', 'checking→in_review', 'in_review→approved', 'approved→closed',
    ]);
    // 새 기록의 모든 시각이 초 단위(엔티티의 created_at·submitted_at·ended_at 포함 — task.yaml 과 task.created 는 tests/task-flow.test.ts 가 본다)
    const times: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.yaml') && name !== 'task.yaml' && !name.endsWith('.output.yaml')) {
          for (const m of readFileSync(p, 'utf8').matchAll(/^\s*(?:created_at|submitted_at|ended_at): "?([^"\n]+)"?$/gm)) times.push(m[1]!);
        }
      }
    };
    walk(taskDir);
    expect(times.length).toBeGreaterThan(20);
    expect(times.filter((t) => !SECONDS_UTC.test(t))).toEqual([]);
    expect(events().slice(1).filter((e) => !SECONDS_UTC.test(e.at))).toEqual([]);
    // Run 의 packet_gaps 는 역할 세션의 출력에서 도구가 옮겼다
    const runYaml = (rel: string) => parse(readFileSync(join(taskDir, rel), 'utf8')) as Json;
    expect(runYaml('runs/R-001.yaml').packet_gaps).toEqual(['Planner 의 부족']);
    expect(runYaml('steps/step-001/runs/R-007.yaml').packet_gaps).toEqual(['R-007 의 부족']);
    expect(readFileSync(join(taskDir, 'steps', 'step-001', 'gates', 'G-001.deterministic.md'), 'utf8')).toBe('# typecheck pass\n# test fail\n');
    // 입구가 받은 로컬 경로는 어디에도 없다
    expect(containsPath(allText(dataDir), entry.inputs)).toBe(false);
    // task branch 의 validate-data 가 0 failed
    const v = validateData(dataDir);
    expect(v.status, v.all).toBe(0);
    expect(v.stdout).toMatch(/ 0 failed/);
    expect(log).toHaveLength(20);
  }, 120_000);
});
