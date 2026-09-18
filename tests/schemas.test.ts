import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const schemaDir = join(import.meta.dirname, '..', 'schemas');
const load = (name: string) => JSON.parse(readFileSync(join(schemaDir, `${name}.schema.json`), 'utf8'));

function ajv() {
  const a = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(a);
  return a;
}

describe('schemas', () => {
  it('모든 스키마가 컴파일된다', () => {
    for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
      expect(() => ajv().compile(JSON.parse(readFileSync(join(schemaDir, file), 'utf8'))), file).not.toThrow();
    }
  });

  const baseStep = {
    id: 'step-001',
    task_id: 'T-0001',
    goal: 'g',
    scope: {},
    inputs: [],
    outputs: [{ name: 'plan.md', type: 'document' }],
    done_when: ['d'],
    approval: 'required',
    status: 'defined',
  };

  it('Step: verify 가 둘 다 비어 있으면 거부한다 (ADR-0003)', () => {
    const validate = ajv().compile(load('step'));
    expect(validate({ ...baseStep, verify: {} })).toBe(false);
    expect(validate({ ...baseStep, verify: { deterministic: [], semantic: [] } })).toBe(false);
    expect(validate({ ...baseStep, verify: { semantic: ['AC 가 모두 계획에 대응되는가'] } })).toBe(true);
    expect(validate({ ...baseStep, verify: { deterministic: [{ name: 'test', run: '@test' }] } })).toBe(true);
  });

  it('Feedback: 승인은 버전이 포함된 artifact_ref 가 필수다 (ADR-0004)', () => {
    const validate = ajv().compile(load('feedback'));
    const base = { id: 'F-001', task_id: 'T-0001', kind: 'approval', channel: 'review', text: '', author: 'me', created_at: '2026-09-18T00:00:00Z' };
    expect(validate(base)).toBe(false);
    expect(validate({ ...base, target: { artifact_ref: 'artifact://T-0001/step-001/plan@v1' } })).toBe(true);
  });

  it('Decision: done 은 AC 별 근거가 필수다', () => {
    const validate = ajv().compile(load('decision'));
    const base = { id: 'D-001', task_id: 'T-0001', action: 'done', rationale: 'r', created_at: '2026-09-18T00:00:00Z' };
    expect(validate(base)).toBe(false);
    expect(validate({ ...base, completion: [{ ac_id: 'AC1', evidence: 'e' }] })).toBe(true);
  });
});
