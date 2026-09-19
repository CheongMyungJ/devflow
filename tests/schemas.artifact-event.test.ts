// T-0005 의 스키마 변경 가운데 artifact 와 event (S7): Artifact 의 내용이 있는 곳(F9, AC9), approved 의 뜻(F-001 (1)(A)),
// Event 의 actor 형식(F6, AC12)과 commit 식별자의 자리(F12, AC3 의 스키마 쪽). 설계는 docs/design/store.md 3.3·3.5·3.6.
// 거부 테스트는 유효한 base 에서 한 가지만 바꾸고, 오류가 기대한 자리에서만 났는지 본다.
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { loadSchemas } from '../src/schema/registry.mjs';
import type { ArtifactVersion, Event } from '../src/types/generated/index.js';

const schemas = loadSchemas();

/**
 * 거부되었고, 모든 오류의 instancePath 가 prefixes 중 하나로 시작한다('' 는 루트 자체).
 * if/then 규칙이 거부하면 ajv 는 실제 오류(then 안의 것)와 함께 루트에 'must match "then" schema'(keyword if)를 하나 더 낸다 —
 * 그것은 요약이라 위치 비교에서 뺀다.
 */
function expectRejectedAt(validate: ValidateFunction, value: unknown, ...prefixes: string[]) {
  expect(validate(value), JSON.stringify(value)).toBe(false);
  const errors = (validate.errors ?? []).filter((e) => e.keyword !== 'if');
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors)
    expect(
      prefixes.some((p) => (p === '' ? e.instancePath === '' : e.instancePath.startsWith(p))),
      `오류 위치 '${e.instancePath}' (${e.keyword}) 가 ${prefixes.join(', ')} 밖이다`,
    ).toBe(true);
}

describe('Artifact: 내용이 있는 곳 (F9, AC9)', () => {
  const validate = schemas.validator('artifact');
  const sha = (c: string) => c.repeat(40);
  const code = { repo: 'devflow', branch: 'task/T-0009-x', base_sha: sha('a'), head_sha: sha('b') };
  const common = { task_id: 'T-0009', step_id: 'step-001', version: 1, author: 'worker', run_id: 'R-002', created_at: '2026-09-19T00:00:00Z' } as const;
  const ref = (name: string) => `artifact://T-0009/step-001/${name}@v1`;

  // 새 모양 넷 — 타입을 붙여 만든다(생성 타입이 stored_in·paths 를 받는다)
  const storeDocument: ArtifactVersion = { ...common, ref: ref('plan'), name: 'plan', type: 'document', stored_in: 'store', content_key: 'blob:T-0009/step-001/R-002.work-notes' };
  const repoDocument: ArtifactVersion = { ...common, ref: ref('store-design'), name: 'store-design', type: 'document', stored_in: 'repo', code, paths: ['docs/design/store.md', 'docs/design/commands.md'] };
  const storeData: ArtifactVersion = { ...common, ref: ref('probe'), name: 'probe', type: 'data', stored_in: 'store', content_key: 'blob:T-0009/step-001/R-002.probe.json' };
  const codeChange: ArtifactVersion = { ...common, ref: ref('change'), name: 'change', type: 'code_change', stored_in: 'repo', code, paths: ['src/store/types.ts'] };
  // 옛 모양 셋 (stored_in 이 없다) — 기존 meta 의 모양 그대로
  const legacyDocumentInRepo = { ...common, ref: ref('store-design'), name: 'store-design', type: 'document', code, approved: true };
  const legacyCodeChange = { ...common, ref: ref('change'), name: 'change', type: 'code_change', code, work_notes_key: 'blob:T-0009/step-001/R-002.work-notes', approved: false };
  const legacyDocumentInStore = { ...common, ref: ref('work-notes'), name: 'work-notes', type: 'document', content_key: 'blob:T-0009/step-001/R-002.work-notes', approved: true };

  it('새 모양 넷과 옛 모양 셋이 통과한다', () => {
    for (const value of [storeDocument, repoDocument, storeData, codeChange, legacyDocumentInRepo, legacyCodeChange, legacyDocumentInStore])
      expect(validate(value), `${value.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
  });

  it('모순된 예 13개를 거부한다', () => {
    const { content_key: _k, ...storeWithoutKey } = storeDocument;
    const { code: _c, ...repoWithoutCode } = repoDocument;
    const { paths: _p, ...repoWithoutPaths } = repoDocument;
    const { code: _lc, ...legacyNeither } = legacyDocumentInRepo;
    const cases: [string, unknown, string[]][] = [
      ['store 인데 content_key 없음', storeWithoutKey, ['']],
      ['store 인데 code', { ...storeDocument, code }, ['/code']],
      ['repo 인데 code 없음', repoWithoutCode, ['']],
      ['repo 인데 paths 없음', repoWithoutPaths, ['']],
      ['repo 인데 content_key', { ...repoDocument, content_key: 'blob:T-0009/step-001/R-002.work-notes' }, ['/content_key']],
      ['code_change 가 store', { ...codeChange, stored_in: 'store', content_key: 'blob:T-0009/step-001/R-002.work-notes', code: undefined, paths: undefined }, ['', '/type', '/stored_in', '/content_key']],
      ['code_change 에 content_key', { ...legacyCodeChange, content_key: 'blob:T-0009/step-001/R-002.work-notes' }, ['', '/content_key']],
      ['옛 모양에 content_key 와 code 둘 다', { ...legacyDocumentInRepo, content_key: 'blob:T-0009/step-001/R-002.work-notes' }, ['']],
      ['옛 모양에 둘 다 없음', legacyNeither, ['']],
      ['옛 모양에 paths', { ...legacyDocumentInRepo, paths: ['docs/design/store.md'] }, ['/paths']],
      ['content_key 가 blob 문법이 아님', { ...storeDocument, content_key: 'runs/R-002.work-notes.md' }, ['/content_key']],
      ['paths 에 드라이브 문자로 시작하는 경로', { ...repoDocument, paths: ['C:/example/docs/design/store.md'] }, ['/paths/0']],
      ['paths 에 ..', { ...repoDocument, paths: ['docs/../../secret.md'] }, ['/paths/0']],
    ];
    expect(cases).toHaveLength(13);
    for (const [label, value, at] of cases) {
      // undefined 로 지운 필드는 JSON 에서 빠진다(YAML 로 쓴 기록과 같은 모양)
      const plain = JSON.parse(JSON.stringify(value));
      expect(validate(plain), label).toBe(false);
      expectRejectedAt(validate, plain, ...at);
    }
  });

  it('store 에 paths, repo 에 빈 paths 도 거부한다', () => {
    expectRejectedAt(validate, { ...storeDocument, paths: ['docs/x.md'] }, '/paths');
    expectRejectedAt(validate, { ...repoDocument, paths: [] }, '/paths');
  });

  it('paths 는 repo 상대 경로만 받는다 — 로컬 경로·URL·. 과 .. 조각을 거부한다', () => {
    for (const p of ['docs/design/store.md', '.devflow.yaml', 'src/store/file/file-store.ts', 'tests/fixtures/record-gate/data/T-9001/task.yaml'])
      expect(validate({ ...repoDocument, paths: [p] }), p).toBe(true);
    for (const p of ['C:\\example\\x.md', 'D:/example/x.md', '/home/example/x.md', '\\\\server\\share\\x', './docs/x.md', 'docs/./x.md', 'docs/../x.md', '..', '.', 'docs//x.md', 'docs/', 'https://example.com/x', 'file:///C:/x', 'docs\\x.md', '', 'a\nb'])
      expectRejectedAt(validate, { ...repoDocument, paths: [p] }, '/paths/0');
  });

  it('content_key·work_notes_key 는 Store 가 읽을 수 있는 blob key 만 받는다 (store.md 3.3)', () => {
    const valid = [
      'blob:T-0004/step-001/R-002.work-notes', // 기존 meta 의 모양
      'blob:T-0001/step-001/R-005.probe',
      'blob:T-0002/R-001.output.yaml', // Task 수준 Run
      'blob:T-0001/step-001/G-001.deterministic', // Gate 가 소유
      'blob:T-0001/step-001/R-002.partial.diff',
      'blob:T-0001/step-001/R-1000.transcript.jsonl',
    ];
    const invalid = [
      'blob:key', // step 스키마의 느슨한 문법은 통과하지만 Store 의 key 가 아니다
      'blob:T-0001/step-001/x.md',
      'blob:T-0001/step-001/R-002.yaml', // Run 기록 자체의 파일 이름
      'blob:T-0001/step-001/R-002.md',
      'blob:T-0001/step-001/R-002.work-notes.md', // .md 는 key 에 쓰지 않는다
      'blob:T-0001/step-001/R-002.a.b',
      'blob:T-0001/step-001/F-002.x', // Feedback 은 blob 을 소유하지 않는다
      'blob:T-0001/G-001.deterministic', // Gate 는 언제나 Step 수준
      'blob:T-0001/step-001/R-02.work-notes',
      'blob:/T-0001/step-001/R-002.work-notes',
      'blob:T-0001/step-001/../R-002.work-notes',
      'T-0001/step-001/R-002.work-notes',
      'blob:T-0001/step-001/R-002.work-notes ',
    ];
    for (const key of valid) {
      expect(validate({ ...storeDocument, content_key: key }), key).toBe(true);
      expect(validate({ ...codeChange, work_notes_key: key }), key).toBe(true);
    }
    for (const key of invalid) {
      expectRejectedAt(validate, { ...storeDocument, content_key: key }, '/content_key');
      expectRejectedAt(validate, { ...codeChange, work_notes_key: key }, '/work_notes_key');
    }
  });

  it('approved 는 옛 기록의 필드로 남는다 — 있어도 없어도 통과하고 기본값이 없다 (F-001 (1)(A))', () => {
    const artifact = JSON.parse(JSON.stringify(schemas.validator('artifact').schema)) as { properties: { approved: Record<string, unknown> } };
    expect(artifact.properties.approved).not.toHaveProperty('default');
    expect(String(artifact.properties.approved.description)).toMatch(/옛 기록의 필드/);
    expect(String(artifact.properties.approved.description)).toMatch(/승인 여부의 기준이 아니다/);
    expect(validate(storeDocument)).toBe(true);
    for (const approved of [true, false]) expect(validate({ ...legacyDocumentInStore, approved })).toBe(true);
    expectRejectedAt(validate, { ...storeDocument, approved: 'yes' }, '/approved');
  });
});

describe('Event: actor 의 형식 (F6, AC12)', () => {
  const validate = schemas.validator('event');
  const base: Event = { seq: 1, task_id: 'T-0009', type: 'task.created', actor: 'system', at: '2026-09-19T00:00:00Z' };

  it('형식에 맞는 actor 가 통과한다 (기존 기록과 Store 의 테스트가 쓰는 값 포함)', () => {
    for (const actor of ['system', 'human:CheongMyungJ', 'human:tester', 'human:someone-else', 'human:a', 'role:intake', 'role:worker', 'role:reviewer', 'role:planner'])
      expect(validate({ ...base, actor }), actor).toBe(true);
  });

  it('틀린 actor 를 거부한다', () => {
    const bad = [
      'human:', // 빈 id
      'human',
      'role:', // 없는 역할
      'role:admin',
      'role:orchestrator',
      'role:Worker', // 대문자
      'ROLE:worker',
      'Human:x',
      'System',
      'system ', // 앞뒤 공백
      ' system',
      'user:x',
      'worker',
      '',
      'human:x\nsystem',
    ];
    for (const actor of bad) expectRejectedAt(validate, { ...base, actor }, '/actor');
    expectRejectedAt(validate, { ...base, actor: 42 }, '/actor');
  });
});

describe('Event: commit 식별자의 자리 (F12, AC3 의 스키마 쪽)', () => {
  const validate = schemas.validator('event');
  const base: Event = { seq: 1, task_id: 'T-0009', type: 'task.created', actor: 'system', at: '2026-09-19T00:00:00Z' };

  it('선택 필드다 — 없는 이벤트(옛 기록, 0단계의 운영 스크립트)가 통과한다', () => {
    expect(validate(base)).toBe(true);
  });

  it('UUID 의 소문자 문자열이 통과한다 — 버전을 고정하지 않는다', () => {
    const withId: Event = { ...base, commit_id: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b' };
    expect(validate(withId)).toBe(true);
    for (const id of ['00000000-0000-0000-0000-000000000000', '0192f0c4-7b1a-7c3d-9e2f-4a5b6c7d8e9f', '3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b'])
      expect(validate({ ...base, commit_id: id }), id).toBe(true);
  });

  it('UUID 가 아니거나 대문자인 값을 거부한다', () => {
    for (const id of ['3F2B8C1E-9A4D-4E6F-8B2A-1C3D5E7F9A0B', '3f2b8c1e9a4d4e6f8b2a1c3d5e7f9a0b', '{3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b}', '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0', 'T-0009#1', '', ' 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b'])
      expectRejectedAt(validate, { ...base, commit_id: id }, '/commit_id');
    expectRejectedAt(validate, { ...base, commit_id: 1 }, '/commit_id');
  });
});
