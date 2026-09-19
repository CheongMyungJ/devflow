// Step status 의 허용 전이표 (docs/design/commands.md 7절). 표 전체가 여기 한 곳에 있고, Step 의 status 를 바꾸는(또는 그대로 두는)
// command 는 모두 nextStepStatus 로 판단한다. 표에 없는 전이는 아무것도 쓰기 전에 거부한다(RejectedInputError).
// 문서의 표와 한 줄씩 같은지는 tests/commands/transitions.test.ts 가 문서를 읽어 대 본다.

import type { NewEvent } from '../store/types.js';
import type { Step } from '../types/generated/index.js';
import { RejectedInputError } from './errors.js';

export type StepStatus = Step['status'];

/** 전이를 일으키는 command. 괄호는 같은 command 의 갈래(role, verdict)다. cancelStep 은 아직 없다(표에만 있다). */
export type TransitionCommand =
  | 'recordDecision'
  | 'defineStep'
  | 'submitRun(worker)'
  | 'submitRun(reviewer)'
  | 'completeRun'
  | 'recordGate(pass)'
  | 'recordGate(fail)'
  | 'requestRevision'
  | 'approveStep'
  | 'cancelStep';

export interface StepTransition {
  /** null = Step 이 아직 없다. */
  from: StepStatus | null;
  /** 'same' = 그대로(status 를 바꾸지 않고 step.status_changed 도 쓰지 않는다). */
  to: StepStatus | 'same';
  command: TransitionCommand;
}

/** commands.md 7절의 표. 순서도 문서와 같다. */
export const STEP_TRANSITIONS: readonly StepTransition[] = Object.freeze([
  { from: null, to: 'proposed', command: 'recordDecision' },
  { from: 'proposed', to: 'defined', command: 'defineStep' },
  { from: 'defined', to: 'running', command: 'submitRun(worker)' },
  { from: 'running', to: 'same', command: 'submitRun(worker)' },
  { from: 'running', to: 'checking', command: 'completeRun' },
  { from: 'checking', to: 'same', command: 'submitRun(reviewer)' },
  { from: 'checking', to: 'in_review', command: 'recordGate(pass)' },
  { from: 'checking', to: 'revising', command: 'recordGate(fail)' },
  { from: 'in_review', to: 'revising', command: 'requestRevision' },
  { from: 'revising', to: 'same', command: 'submitRun(worker)' },
  { from: 'revising', to: 'checking', command: 'completeRun' },
  { from: 'in_review', to: 'approved', command: 'approveStep' },
  { from: 'approved', to: 'closed', command: 'approveStep' },
  ...(['proposed', 'defined', 'running', 'checking', 'in_review', 'revising'] as const).map((from) => ({ from, to: 'cancelled' as const, command: 'cancelStep' as const })),
] satisfies StepTransition[]);

/**
 * command 가 지금 status 에서 할 수 있는 전이의 다음 status. 'same' 이면 지금 status 를 돌려준다.
 * 표에 없으면 RejectedInputError — 까닭에 그 command 가 받는 status 를 적는다.
 * @param current 지금 status. Step 이 없으면 null.
 */
export function nextStepStatus(command: TransitionCommand, current: StepStatus | null, subject: string): StepStatus {
  const row = STEP_TRANSITIONS.find((t) => t.command === command && t.from === current);
  if (row === undefined) {
    const allowed = STEP_TRANSITIONS.filter((t) => t.command === command).map((t) => t.from ?? '(없음)');
    throw new RejectedInputError([
      `${subject}: status 가 ${current ?? '(없음)'} 다 — ${command} 는 ${allowed.join('·')} 에서만 한다 (허용 전이표, commands.md 7절)`,
    ]);
  }
  return row.to === 'same' ? (current as StepStatus) : row.to;
}

/**
 * status 를 바꾸는 command 가 step.yaml 과 같은 commit 에 쓰는 step.status_changed. 바뀌지 않았으면 빈 배열.
 * data 는 첫 이벤트에만 붙인다(승인의 official_gate).
 */
export function statusChangedEvents(
  stepId: string,
  path: readonly StepStatus[],
  base: Pick<NewEvent, 'at'> & Partial<Pick<NewEvent, 'system_sha'>>,
  firstData: Record<string, unknown> = {},
): NewEvent[] {
  const events: NewEvent[] = [];
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1]!;
    const to = path[i]!;
    if (from === to) continue;
    events.push({ type: 'step.status_changed', actor: 'system', step_id: stepId, data: { from, to, ...(events.length === 0 ? firstData : {}) }, ...base });
  }
  return events;
}
