// validate-data 의 이름 규칙이 Store 의 list 규칙(docs/design/store.md 3.1, src/store/file/layout.ts)과 같은가 (T-0005 step-003, G-002 의 B).
// 같은 디렉터리에 여러 이름의 파일을 두고, validate-data 가 그 kind 로 검사한 파일과 Store 의 list 가 읽은 파일(items + invalid)을 맞대 본다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSample, newStore, tempDataDir } from './helpers.js';
import { REPO_ROOT } from './paths.js';
import { event, step } from './records.js';

function validateData(dataDir: string) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'validate-data.mjs'), dataDir], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 모양이 맞든 틀리든 스키마를 통과하지 못하는 내용. 읽히면 validate-data 는 FAIL, Store 는 invalid 로 드러난다. */
const BROKEN = 'broken: true\n';

describe('validate-data 와 Store 의 list 는 같은 이름의 파일을 그 kind 로 읽는다', () => {
  it('gates/·decisions/·feedback/·runs/ 에서 D-/F-/R-/G-NNN.yaml 만 — 그 밖의 이름(blob, 백업, 메모)은 어느 쪽도 세지 않는다', async () => {
    const dataDir = tempDataDir();
    const store = newStore(dataDir);
    const task = await createSample(store);
    const t = task.id;
    await store.commit(t, { writes: [{ kind: 'step', value: step(t, 'step-001') }], events: [event('step.defined')] });
    const dirs = {
      decisions: join(dataDir, t, 'decisions'),
      feedback: join(dataDir, t, 'feedback'),
      runs: join(dataDir, t, 'runs'),
      stepFeedback: join(dataDir, t, 'steps', 'step-001', 'feedback'),
      stepRuns: join(dataDir, t, 'steps', 'step-001', 'runs'),
      gates: join(dataDir, t, 'steps', 'step-001', 'gates'),
    };
    const files: Record<keyof typeof dirs, string[]> = {
      decisions: ['D-001.yaml', 'D-9.yaml', 'D-002.bak.yaml', 'notes.yaml', 'd-003.yaml', 'D-004.yml'],
      feedback: ['F-001.yaml', 'F-002.summary.yaml', 'x.yaml'],
      runs: ['R-001.yaml', 'R-001.output.yaml', 'R-0012.yaml', 'R-002.work-notes.md'],
      stepFeedback: ['F-003.yaml', 'F-3.yaml', 'F-004.old.yaml'],
      stepRuns: ['R-003.yaml', 'R-003.output.yaml', 'R-003.output.json', 'R-004.transcript.jsonl'],
      gates: ['G-001.yaml', 'G-001.summary.yaml', 'G-001.deterministic.md', 'G-002.log.yaml', 'G-10.yaml', 'gate.yaml'],
    };
    for (const [key, names] of Object.entries(files)) {
      mkdirSync(dirs[key as keyof typeof dirs], { recursive: true });
      for (const name of names) writeFileSync(join(dirs[key as keyof typeof dirs], name), BROKEN);
    }

    // validate-data 가 FAIL 로 보고한 파일 = 그 kind 로 읽은 파일 (task·step·이벤트는 올바르다)
    const r = validateData(dataDir);
    const failed = [...r.stderr.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]!).sort();
    const expected = [
      `${t}/decisions/D-001.yaml`,
      `${t}/decisions/D-9.yaml`,
      `${t}/feedback/F-001.yaml`,
      `${t}/runs/R-0012.yaml`,
      `${t}/runs/R-001.yaml`,
      `${t}/steps/step-001/feedback/F-003.yaml`,
      `${t}/steps/step-001/feedback/F-3.yaml`,
      `${t}/steps/step-001/gates/G-001.yaml`,
      `${t}/steps/step-001/gates/G-10.yaml`,
      `${t}/steps/step-001/runs/R-003.yaml`,
    ].sort();
    expect(failed).toEqual(expected);

    // Store 의 list 가 읽은 것(모두 invalid — 내용이 깨져 있다). subject 는 식별자다
    const readByStore: string[] = [];
    const scopes = [
      ['decision', { taskId: t }, 'decisions'],
      ['feedback', { taskId: t }, 'feedback'],
      ['run', { taskId: t }, 'runs'],
      ['gate_result', { taskId: t }, 'gates'],
    ] as const;
    for (const [kind, scope] of scopes) {
      const listed = await store.list(kind, scope);
      expect(listed.items).toEqual([]);
      readByStore.push(...listed.invalid.map((i) => `${kind} ${i.subject}`));
    }
    // validate-data 의 파일을 같은 식별자로 옮겨 맞대 본다
    const kindOf = { decisions: 'decision', feedback: 'feedback', runs: 'run', gates: 'gate_result' } as const;
    const fromValidateData = failed.map((label) => {
      const parts = label.split('/');
      const kind = kindOf[parts.at(-2) as keyof typeof kindOf];
      const id = parts.at(-1)!.replace(/\.yaml$/, '');
      const stepId = parts[1] === 'steps' ? parts[2] : undefined;
      return kind === 'gate_result' ? `${kind} gate_result ${t}/${stepId}/${id}` : `${kind} ${kind} ${t}/${id}`;
    });
    expect(readByStore.sort()).toEqual(fromValidateData.sort());
  });
});
