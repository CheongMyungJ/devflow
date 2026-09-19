// blob key 의 문법이 세 곳 — artifact 스키마의 $defs/blobKey(정규식), src/store/blob-ref.ts 의 blobRef·parseBlobRef,
// 파일 구현체의 key → 파일(src/store/file/layout.ts) — 에서 같은지 같은 key 목록으로 확인한다 (store.md 3.3, G-002 의 B).
// 파일 이름 규칙(list 가 kind 로 읽는 이름, nextId 가 세는 이름, key → 파일)이 한 곳(layout.ts)에서 서로 맞는지도 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSchemas } from '../../src/schema/registry.mjs';
import { blobRef, parseBlobRef } from '../../src/store/blob-ref.js';
import { InvalidChangeError } from '../../src/store/errors.js';
import { blobRelPath, issuedNumberOf, locOfRel, relOfLoc, type Loc } from '../../src/store/file/layout.js';
import type { BlobOwner } from '../../src/store/types.js';

const registry = loadSchemas();
const schemaPattern = new RegExp(JSON.parse(readFileSync(join(registry.schemaDir, 'artifact.schema.json'), 'utf8')).$defs.blobKey.pattern, 'u');
/** 스키마 검증 그대로(ajv): content_key 에 넣은 meta 가 통과하는가. */
const metaWith = (key: string) => ({
  ref: 'artifact://T-0001/step-001/plan@v1',
  task_id: 'T-0001',
  step_id: 'step-001',
  name: 'plan',
  version: 1,
  type: 'document',
  author: 'worker',
  stored_in: 'store',
  content_key: key,
  created_at: '2026-01-01T00:00:00Z',
});
const schemaAccepts = (key: string) => registry.validator('artifact')(metaWith(key)) === true;

const VALID = [
  'blob:T-0001/step-001/R-002.work-notes',
  'blob:T-0001/step-001/R-002.output.yaml',
  'blob:T-0001/step-001/R-002.output.json',
  'blob:T-0001/step-001/R-002.partial.diff',
  'blob:T-0001/step-001/R-002.transcript.jsonl',
  'blob:T-0001/step-001/R-002.notes.txt',
  'blob:T-0001/step-001/R-002.run.log',
  'blob:T-0001/step-001/G-001.deterministic',
  'blob:T-0001/step-001/G-001.summary.yaml',
  'blob:T-0003/R-015.output.yaml',
  'blob:T-0005/R-007.packet',
  'blob:T-12345/step-1234/R-1234.x',
  'blob:T-0001/step-001/R-0012.x', // 4자리 이상도 문법으로는 된다(쓰기 때의 ID 모양 검사는 엔티티에만)
  'blob:T-0001/step-001/R-002.A_b-9',
  'blob:T-0001/step-001/R-002.jsonx',
  'blob:T-0001/step-001/R-002.LOG', // 확장자 이름의 금지는 소문자만이다(스키마의 pattern 과 같다)
  'blob:T-0001/step-001/R-002.mdx',
];
const INVALID = [
  'blob:key',
  'blob:T-0001/R-002',
  'blob:T-0001/step-001/R-002',
  'blob:T-0001/step-001/R-002.',
  'blob:T-0001/step-001/R-002.yaml', // Run 기록 자체의 파일 이름
  'blob:T-0001/step-001/R-002.md',
  'blob:T-0001/step-001/R-002.json',
  'blob:T-0001/step-001/R-002.log',
  'blob:T-0001/step-001/R-002.work-notes.md',
  'blob:T-0001/step-001/R-002.a.b',
  'blob:T-0001/step-001/R-002.log.json',
  'blob:T-0001/step-001/R-002.-x',
  'blob:T-0001/step-001/R-002._x',
  'blob:T-0001/step-001/R-002.x.JSON',
  'blob:T-0001/step-001/R-02.x',
  'blob:T-0001/step-01/R-002.x',
  'blob:T-001/step-001/R-002.x',
  'blob:T-0001/G-001.deterministic', // Gate 는 언제나 Step 수준
  'blob:T-0001/step-001/F-001.x',
  'blob:T-0001/step-001/D-001.x',
  'blob:T-0001/step-001/r-002.x',
  'blob:T-0001/step-001/R-002.x/y',
  'blob:T-0001/step-001/../R-002.x',
  'blob:T-0001/step-001/step-002/R-002.x',
  'blob:T-0001/step-001/R-002.x\n',
  'blob:T-0001/step-001/R-002.x ',
  'blob:T-0001/step-001/R-002.노트',
  'blob:/T-0001/step-001/R-002.x',
  'BLOB:T-0001/step-001/R-002.x',
  'T-0001/step-001/R-002.x',
  'runs/R-002.work-notes.md',
  '',
];

describe('blob key 의 문법이 스키마·blob-ref·파일 구현체에서 같다', () => {
  it('목록의 모든 key 에서 스키마의 pattern, ajv 의 검증, parseBlobRef 가 같은 판정을 한다', () => {
    for (const key of [...VALID, ...INVALID]) {
      const expected = VALID.includes(key);
      expect(schemaPattern.test(key), `pattern: ${JSON.stringify(key)}`).toBe(expected);
      expect(schemaAccepts(key), `ajv: ${JSON.stringify(key)}`).toBe(expected);
      expect(parseBlobRef(key) !== undefined, `parseBlobRef: ${JSON.stringify(key)}`).toBe(expected);
    }
  });

  it('blobRef 가 만드는 key 는 스키마를 통과하고 parseBlobRef 로 나누면 준 것이 돌아온다', () => {
    const cases: Array<[BlobOwner, string]> = [
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, 'work-notes'],
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, 'output.json'],
      [{ taskId: 'T-0001', runId: 'R-001' }, 'output.yaml'],
      [{ taskId: 'T-0001', stepId: 'step-003', gateId: 'G-007' }, 'deterministic'],
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, 'transcript.jsonl'],
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, 'partial.diff'],
    ];
    for (const [owner, name] of cases) {
      const key = blobRef(owner, name);
      expect(schemaAccepts(key), key).toBe(true);
      const parsed = parseBlobRef(key)!;
      expect(parsed.taskId).toBe(owner.taskId);
      expect(parsed.stepId).toBe(owner.stepId);
      expect(parsed.ownerId).toBe('gateId' in owner ? owner.gateId : owner.runId);
      expect(parsed.name).toBe(name);
    }
  });

  it('blobRef 는 문법에 맞지 않는 소유자·이름을 InvalidChangeError 로 거부한다 (조각에 섞인 / 로 다르게 나뉘는 것 포함)', () => {
    const bad: Array<[BlobOwner, string]> = [
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, 'yaml'],
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, 'a.b'],
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, 'notes.md'],
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002' }, ''],
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'F-002' }, 'x'],
      [{ taskId: 'T-0001', stepId: 'step-001', gateId: 'R-002' }, 'x'], // Gate 자리에 Run ID
      [{ taskId: 'T-0001/step-001', runId: 'R-002' }, 'x'], // 나누면 Step 수준이 된다
      [{ taskId: 'T-0001', stepId: 'step-001', runId: 'R-002.a' }, 'b'],
      [{ taskId: '../T-0001', runId: 'R-002' }, 'x'],
    ];
    for (const [owner, name] of bad) expect(() => blobRef(owner, name), `${JSON.stringify(owner)} ${name}`).toThrow(InvalidChangeError);
  });

  it('key → 파일(layout.ts)과 파일 → key 가 일대일이다: 유효한 key 는 blob 인 파일로, 그 파일은 같은 key 로 돌아온다', () => {
    const files = new Set<string>();
    for (const key of VALID) {
      const parsed = parseBlobRef(key)!;
      const rel = blobRelPath(parsed);
      files.add(`${parsed.taskId}/${rel}`);
      const back = locOfRel(parsed.taskId, rel);
      expect(back, `${key} → ${rel}`).toEqual({ kind: 'blob', ref: parsed });
    }
    expect(files.size).toBe(VALID.length); // 두 key 가 한 파일이 되지 않는다
    // 실제 기록의 파일 이름
    expect(blobRelPath(parseBlobRef('blob:T-0004/step-001/R-002.work-notes')!)).toBe('steps/step-001/runs/R-002.work-notes.md');
    expect(blobRelPath(parseBlobRef('blob:T-0003/R-015.output.yaml')!)).toBe('runs/R-015.output.yaml');
    expect(blobRelPath(parseBlobRef('blob:T-0005/step-002/G-002.deterministic')!)).toBe('steps/step-002/gates/G-002.deterministic.md');
  });

  it('기록의 파일과 blob 의 파일이 겹치지 않는다: list 가 kind 로 읽는 이름은 blob 이 아니고, blob 이 아닌 이름은 세지 않는다', () => {
    const t = 'T-0001';
    const cases: Array<[string, Loc | { kind: 'blob' } | undefined]> = [
      ['task.yaml', { kind: 'task' }],
      ['steps/step-001/step.yaml', { kind: 'step', stepId: 'step-001' }],
      ['decisions/D-001.yaml', { kind: 'decision', id: 'D-001' }],
      ['feedback/F-004.yaml', { kind: 'feedback', id: 'F-004' }],
      ['steps/step-001/feedback/F-001.yaml', { kind: 'feedback', id: 'F-001', stepId: 'step-001' }],
      ['runs/R-001.yaml', { kind: 'run', id: 'R-001' }],
      ['steps/step-001/runs/R-002.yaml', { kind: 'run', id: 'R-002', stepId: 'step-001' }],
      ['steps/step-001/gates/G-001.yaml', { kind: 'gate_result', id: 'G-001', stepId: 'step-001' }],
      ['steps/step-001/artifacts/plan/v1.meta.yaml', { kind: 'artifact', stepId: 'step-001', name: 'plan', version: 1 }],
      ['runs/R-001.output.yaml', { kind: 'blob' }],
      ['steps/step-001/runs/R-002.work-notes.md', { kind: 'blob' }],
      ['steps/step-001/gates/G-001.deterministic.md', { kind: 'blob' }],
      ['steps/step-001/gates/G-001.summary.yaml', { kind: 'blob' }],
      // 어느 것도 아닌 것
      ['ledger.md', undefined],
      ['intent.md', undefined],
      ['gates/G-001.yaml', undefined], // Task 수준 gates/ 는 없다
      ['steps/step-001/decisions/D-001.yaml', undefined],
      ['decisions/D-001.bak.yaml', undefined],
      ['decisions/notes.yaml', undefined],
      ['steps/step-001/runs/R-002.work-notes', undefined], // .md 가 없다
      ['steps/step-001/runs/R-002.x.json.md', undefined],
      ['steps/step-001/runs/G-001.deterministic.md', undefined], // runs/ 에 Gate 의 blob
      ['steps/step-001/gates/R-002.work-notes.md', undefined],
      ['steps/step-001/gates/G-001.log.yaml', undefined], // label 이 확장자 이름
      ['steps/step-001/artifacts/plan/v1.md', undefined],
      ['steps/notes/step.yaml', undefined],
    ];
    for (const [rel, expected] of cases) {
      const loc = locOfRel(t, rel);
      if (expected?.kind === 'blob') expect(loc?.kind, rel).toBe('blob');
      else expect(loc, rel).toEqual(expected);
      if (loc && loc.kind !== 'blob') expect(relOfLoc(loc), rel).toBe(rel); // 자리 → 파일 이 되돌아온다
    }
    // nextId 는 기록과 blob 의 소유자를 같은 규칙으로 센다
    expect(issuedNumberOf(t, 'steps/step-002/runs/R-012.failed.md', 'run')).toBe(12);
    expect(issuedNumberOf(t, 'steps/step-002/runs/R-012.failed.md', 'gate_result')).toBeUndefined();
    expect(issuedNumberOf(t, 'steps/step-003/gates/G-009.deterministic.md', 'gate_result')).toBe(9);
    expect(issuedNumberOf(t, 'steps/step-003/gates/G-009.deterministic.md', 'step')).toBe(3);
    expect(issuedNumberOf(t, 'decisions/D-001.bak.yaml', 'decision')).toBeUndefined();
    expect(issuedNumberOf(t, 'steps/step-001/runs/R-002.x.json.md', 'run')).toBeUndefined();
  });
});
