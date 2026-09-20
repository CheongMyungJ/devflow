import { describe, expect, it } from 'vitest';
import { createIntake, submitIntake, collectIntake, confirmIntakeIntent, publishIntake } from '../../src/commands/intake.js';
import { getIntake } from '../../src/queries/intake.js';
import { ready, spec, terminal, until } from './helpers.js';
import type { IntakeOutput } from '../../src/types/generated/index.js';

const intent = { problem: 'Need an example', goal: 'Provide it', success_criteria: [{ id: 'S1', text: 'The example exists' }], affected: [], constraints: [], non_goals: [], open_questions: [] };
async function turn(s: Awaited<ReturnType<typeof ready>>, id: string, output: IntakeOutput) {
  const input = { prompt: spec('success', 0, JSON.stringify(output)).prompt };
  const started = await submitIntake(s.ctx, { id, input });
  const current = started.draft.turns.at(-1)!;
  await until(() => s.runner.inspect({ taskId: id, runId: current.id, executionId: current.execution_id }), terminal);
  return (await collectIntake(s.ctx, { id })).draft;
}
describe('two-stage Intake', () => {
  it('requires both versioned human confirmations and issues one Task', async () => {
    const s = await ready(); const initial = await createIntake(s.ctx, { text: 'Create an example' });
    await expect(publishIntake(s.ctx, { id: initial.id, version: initial.revision })).rejects.toThrow(/definition/);
    const first = await turn(s, initial.id, { phase: 'intent', summary: 'Confirm this intent', packet_gaps: [], intent });
    expect(first.turns.at(-1)?.status).toBe('completed');
    const changed = structuredClone(first); changed.revision++;
    changed.events.push({ type: 'message', actor: 'human:tester', at: new Date().toISOString(), text: 'attempt to overwrite' });
    changed.turns[0]!.output!.summary = 'rewritten';
    await expect(s.store.intake!.put(changed, first.revision)).rejects.toThrow(/immutable/);
    await expect(confirmIntakeIntent(s.ctx, { id: first.id, version: first.revision - 1 })).rejects.toThrow(/current/);
    await confirmIntakeIntent(s.ctx, { id: first.id, version: first.revision });
    const second = await turn(s, initial.id, { phase: 'definition', summary: 'Confirm these criteria', packet_gaps: [],
      definition: { ...intent, title: 'Example', type: 'feature', acceptance_criteria: [{ id: 'AC1', text: 'Example exists', covers: ['S1'] }], target: { repo: 'sample', base_branch: 'trunk', base_source: 'local' } } });
    expect(second.turns.at(-1)?.status).toBe('completed');
    const count = (await s.store.list('task', {})).items.length;
    const done = await publishIntake(s.ctx, { id: second.id, version: second.revision });
    expect(done.phase).toBe('issued');
    expect(await publishIntake(s.ctx, { id: second.id, version: second.revision })).toEqual(done);
    expect((await s.store.list('task', {})).items).toHaveLength(count + 1);
    expect((await s.store.readEvents(done.task_id!))[0]?.actor).toBe('human:tester');
    expect((await getIntake(s.ctx, { id: done.id })).draft.events.map(e => e.type)).toEqual(['created', 'submitted', 'collected', 'intent_confirmed', 'submitted', 'collected', 'publish_requested', 'issued']);
  });
  it('does not allow definition output to silently change confirmed intent', async () => {
    const s = await ready(); const initial = await createIntake(s.ctx, { text: 'Create an example' });
    const first = await turn(s, initial.id, { phase: 'intent', summary: 'Intent', packet_gaps: [], intent });
    await confirmIntakeIntent(s.ctx, { id: first.id, version: first.revision });
    const wrong = await turn(s, initial.id, { phase: 'definition', summary: 'Definition', packet_gaps: [],
      definition: { ...intent, goal: 'A different task', title: 'Example', type: 'feature', acceptance_criteria: [{ id: 'AC1', text: 'Example exists', covers: ['S1'] }], target: { repo: 'sample', base_branch: 'trunk' } } });
    expect(wrong.turns.at(-1)).toMatchObject({ status: 'failed', failure: expect.stringContaining('goal') });
  });
  it('recovers publication after Task creation without creating a duplicate', async () => {
    const s = await ready(); const initial = await createIntake(s.ctx, { text: 'Create an example' });
    const first = await turn(s, initial.id, { phase: 'intent', summary: 'Intent', packet_gaps: [], intent });
    await confirmIntakeIntent(s.ctx, { id: first.id, version: first.revision });
    const second = await turn(s, initial.id, { phase: 'definition', summary: 'Definition', packet_gaps: [],
      definition: { ...intent, title: 'Example', type: 'feature', acceptance_criteria: [{ id: 'AC1', text: 'Example exists', covers: ['S1'] }], target: { repo: 'sample', base_branch: 'trunk', base_source: 'local' } } });
    const put = s.store.intake!.put.bind(s.store.intake);
    s.store.intake!.put = async (draft, revision) => {
      if (draft.phase === 'issued') { s.store.intake!.put = put; throw new Error('simulated crash before receipt'); }
      return put(draft, revision);
    };
    await expect(publishIntake(s.ctx, { id: second.id, version: second.revision })).rejects.toThrow(/simulated crash/);
    const count = (await s.store.list('task', {})).items.length;
    expect((await publishIntake(s.ctx, { id: second.id, version: second.revision })).phase).toBe('issued');
    expect((await s.store.list('task', {})).items).toHaveLength(count);
  });
  it('allows definition repair when publication is rejected before Task creation', async () => {
    const s = await ready(); const initial = await createIntake(s.ctx, { text: 'Create an example' });
    const first = await turn(s, initial.id, { phase: 'intent', summary: 'Intent', packet_gaps: [], intent });
    await confirmIntakeIntent(s.ctx, { id: first.id, version: first.revision });
    const definition = { ...intent, title: 'Example', type: 'feature' as const, acceptance_criteria: [{ id: 'AC1', text: 'Example exists', covers: ['S1'] }], target: { repo: 'sample', base_branch: 'bad..branch', base_source: 'local' as const } };
    const second = await turn(s, initial.id, { phase: 'definition', summary: 'Definition', packet_gaps: [], definition });
    const count = (await s.store.list('task', {})).items.length;
    await expect(publishIntake(s.ctx, { id: second.id, version: second.revision })).rejects.toThrow();
    expect((await getIntake(s.ctx, { id: second.id })).draft.phase).toBe('definition');
    expect((await s.store.list('task', {})).items).toHaveLength(count);
    const fixed = await turn(s, initial.id, { phase: 'definition', summary: 'Fixed branch', packet_gaps: [], definition: { ...definition, target: { ...definition.target, base_branch: 'trunk' } } });
    expect((await publishIntake(s.ctx, { id: fixed.id, version: fixed.revision })).phase).toBe('issued');
    await expect(publishIntake(s.ctx, { id: second.id, version: second.revision })).rejects.toThrow(/published definition version/);
  });
});
