// Step status 의 허용 전이표 (src/commands/transitions.ts — docs/design/commands.md 7절). 표는 한 곳에 있고 문서와 한 줄씩 같다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextStepStatus, RejectedInputError, STEP_TRANSITIONS } from '../../src/commands/index.js';
import { statusChangedEvents } from '../../src/commands/transitions.js';
import { REPO_ROOT } from '../store/paths.js';

/** commands.md 7절의 표를 (from, to, command) 로 읽는다. 한 칸에 from 이 여럿이면(·) 줄을 나눈다. */
function documentedTransitions() {
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'design', 'commands.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 7. Step status 의 허용 전이표'));
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| 지금') && !line.startsWith('|---'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  return rows.flatMap(([from, to, command]) => {
    const m = /([A-Za-z]+)(\((?:worker|reviewer|pass|fail)\))?/.exec(command!.replaceAll('`', ''))!;
    return from!.split('·').map((f) => ({ from: f === '(없음)' ? null : f, to: to === '그대로' ? 'same' : to, command: `${m[1]}${m[2] ?? ''}` }));
  });
}

describe('Step status 의 허용 전이표', () => {
  it('commands.md 7절의 표와 한 줄씩 같다', () => {
    const documented = documentedTransitions();
    expect(documented.length).toBeGreaterThanOrEqual(19);
    expect(STEP_TRANSITIONS.map((t) => ({ ...t }))).toEqual(documented);
  });

  it('표는 src/commands/ 의 한 곳에만 있다 — 다른 command 파일에 전이를 적은 사본이 없다', () => {
    const dir = join(REPO_ROOT, 'src', 'commands');
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && name !== 'transitions.ts')
      .filter((name) => /from:\s*'(proposed|defined|running|checking|in_review|revising|approved)'/.test(readFileSync(join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('표에 있는 전이는 다음 status 를, 그대로(same)는 지금 status 를 준다', () => {
    expect(nextStepStatus('recordDecision', null, 'step-001')).toBe('proposed');
    expect(nextStepStatus('submitRun(worker)', 'defined', 'step-001')).toBe('running');
    expect(nextStepStatus('submitRun(worker)', 'running', 'step-001')).toBe('running');
    expect(nextStepStatus('submitRun(worker)', 'revising', 'step-001')).toBe('revising');
    expect(nextStepStatus('submitRun(reviewer)', 'checking', 'step-001')).toBe('checking');
    expect(nextStepStatus('completeRun', 'revising', 'step-001')).toBe('checking');
    expect(nextStepStatus('recordGate(fail)', 'checking', 'step-001')).toBe('revising');
    expect(nextStepStatus('approveStep', 'approved', 'step-001')).toBe('closed');
  });

  it.each([
    ['completeRun', 'in_review'],
    ['submitRun(worker)', 'closed'],
    ['submitRun(reviewer)', 'running'],
    ['approveStep', 'proposed'],
    ['approveStep', 'checking'],
    ['recordGate(pass)', 'in_review'],
    ['requestRevision', 'checking'],
    ['defineStep', 'defined'],
    ['recordDecision', 'proposed'],
    ['cancelStep', 'closed'],
  ] as const)('표에 없는 전이는 RejectedInputError: %s 를 %s 에서', (command, from) => {
    expect(() => nextStepStatus(command, from, 'step-001')).toThrow(RejectedInputError);
  });

  it('closed·cancelled 에서 나가는 전이는 없다', () => {
    expect(STEP_TRANSITIONS.filter((t) => t.from === 'closed' || t.from === 'cancelled')).toEqual([]);
  });

  it('statusChangedEvents 는 바뀐 걸음마다 하나, 그대로면 없음, data 는 첫 이벤트에만', () => {
    const base = { system_sha: 'a'.repeat(40), at: '2026-09-19T00:00:00Z' };
    expect(statusChangedEvents('step-001', ['running', 'running'], base)).toEqual([]);
    expect(statusChangedEvents('step-001', ['in_review', 'approved', 'closed'], base, { official_gate: 'G-002' })).toEqual([
      { type: 'step.status_changed', actor: 'system', step_id: 'step-001', data: { from: 'in_review', to: 'approved', official_gate: 'G-002' }, ...base },
      { type: 'step.status_changed', actor: 'system', step_id: 'step-001', data: { from: 'approved', to: 'closed' }, ...base },
    ]);
  });
});
