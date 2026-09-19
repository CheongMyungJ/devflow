// submit-run, complete-run, fail-run 입구를 자식 프로세스로 실행한다 (T-0006 step-004 ②). 입구는 <data-dir> <task-id> 를 앞 두 인자로 받고
// 조립 지점에서 받은 commands.* 만 부른다. 역할 세션의 출력·패킷은 데이터 디렉터리 밖의 파일에서 읽고, 그 로컬 경로는 기록되지 않는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { allText, containsPath, entryRunner, validateData } from './entry-helpers.js';
import { contentSnapshot, createSample, newStore, tempDataDir } from './store/helpers.js';
import { event, step } from './store/records.js';

const entry = entryRunner('run-entries');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function data() {
  const dataDir = tempDataDir();
  const store = newStore(dataDir);
  const taskId = (await createSample(store)).id;
  await store.commit(taskId, { writes: [{ kind: 'step', value: step(taskId, 'step-001') }], events: [event('step.defined', { step_id: 'step-001' })] });
  const yaml = (rel: string) => parse(readFileSync(join(dataDir, taskId, rel), 'utf8')) as Record<string, any>;
  return { dataDir, taskId, yaml };
}
const submitWorker = (dataDir: string, taskId: string, ...extra: string[]) =>
  entry.run('submit-run', [dataDir, taskId, '--step', 'step-001', '--role', 'worker', '--access', 'write', '--backend', 'fake', '--session-path', 'new', ...extra]);

describe('submit-run · complete-run · fail-run 입구', () => {
  it('제출 → 실패 → 다시 제출 → 완료: 패킷·출력·작업 노트는 blob 으로, 입력의 로컬 경로는 어디에도 없고, validate-data 0 failed', async () => {
    const { dataDir, taskId, yaml } = await data();
    const packet = entry.file('# R-001 의 패킷\n', 'packet.md');
    let r = submitWorker(dataDir, taskId, '--packet', packet, '--expect-id', 'R-001', '--note', '첫 실행');
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(/^submitted R-001 \(worker\) on T-0001\/step-001, seq 3\.\.4, commit /);
    expect(yaml('steps/step-001/step.yaml').status).toBe('running');
    expect(readFileSync(join(dataDir, taskId, 'steps', 'step-001', 'runs', 'R-001.packet.md'), 'utf8')).toBe('# R-001 의 패킷\n');

    r = entry.run('fail-run', [dataDir, taskId, 'R-001', '--reason', '한도로 끊겼다', '--failed-notes', entry.file('# 경위\n'), '--partial-diff', entry.file('diff\n')]);
    expect(r.status, r.all).toBe(0);
    expect(yaml('steps/step-001/runs/R-001.yaml').status).toBe('failed');
    expect(yaml('steps/step-001/step.yaml').status).toBe('running');

    r = submitWorker(dataDir, taskId);
    expect(r.status, r.all).toBe(0);
    r = entry.run('complete-run', [
      dataDir, taskId, 'R-002',
      '--worker-output', entry.file(JSON.stringify({ summary: 's', packet_gaps: ['gap'] }), 'R-002.output.json'),
      '--work-notes', entry.file('# 노트\n', 'notes.md'),
      '--artifact', 'plan=blob:work-notes',
      '--artifact', `change=code:${SHA_A}..${SHA_B}`,
      '--output-attempts', '1',
    ]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain(`artifact://${taskId}/step-001/plan@v1`);
    expect(yaml('steps/step-001/runs/R-002.yaml')).toMatchObject({ status: 'completed', packet_gaps: ['gap'], output_attempts: 1 });
    expect(yaml('steps/step-001/step.yaml').status).toBe('checking');
    expect(yaml('steps/step-001/artifacts/plan/v1.meta.yaml')).toMatchObject({ content_key: `blob:${taskId}/step-001/R-002.work-notes`, stored_in: 'store' });
    expect(readFileSync(join(dataDir, taskId, 'steps', 'step-001', 'runs', 'R-002.work-notes.md'), 'utf8')).toBe('# 노트\n');
    const v = validateData(dataDir);
    expect(v.status, v.all).toBe(0);
    expect(containsPath(allText(dataDir), entry.inputs)).toBe(false);
  });

  it('사용법 오류는 exit 2, 거부는 exit 1 — 어느 쪽도 아무것도 쓰지 않는다', async () => {
    const { dataDir, taskId } = await data();
    const cases: Array<[string[], string, number, RegExp]> = [
      [[dataDir, taskId, '--step', 'step-001', '--access', 'write', '--backend', 'f', '--session-path', 'new'], 'submit-run', 2, /--role 가 필요하다/],
      [[dataDir, taskId, '--role', 'worker', '--step', 'step-001', '--access', 'write', '--backend', 'f', '--session-path', 'new', '--at', '2026-01-01T00:00:00Z'], 'submit-run', 2, /모르는 옵션 --at/],
      [[dataDir, taskId, '--role', 'worker', '--step', 'step-001', '--access', 'write', '--backend', 'f', '--session-path', 'new', '--actor', 'human:x'], 'submit-run', 2, /모르는 옵션 --actor/],
      [[dataDir, 'T-1', '--role', 'worker', '--step', 'step-001', '--access', 'write', '--backend', 'f', '--session-path', 'new'], 'submit-run', 2, /T-NNNN 모양이 아니다/],
      [[join(dataDir, taskId), '--role', 'worker', '--access', 'write', '--backend', 'f', '--session-path', 'new'], 'submit-run', 2, /usage: submit-run/],
      [[dataDir, taskId, '--role', 'intake', '--access', 'read', '--backend', 'f', '--session-path', 'new'], 'submit-run', 1, /intake Run 은 받지 않는다/],
      [[dataDir, taskId, '--role', 'worker', '--step', 'step-001', '--access', 'write', '--backend', 'f', '--session-path', 'new', '--expect-id', 'R-003'], 'submit-run', 1, /발급될 Run id 는 R-001 다/],
      [[dataDir, taskId, 'R-001', '--artifact', 'plan=blob:work-notes'], 'complete-run', 2, /--worker-output 가 필요하다/],
      [[dataDir, taskId, 'R-001', '--worker-output', join(dataDir, 'none.json'), '--artifact', 'plan=blob:work-notes'], 'complete-run', 1, /--worker-output 을 읽지 못했다/],
      [[dataDir, taskId, 'R-001', '--worker-output', entry.file('{}'), '--artifact', 'plan'], 'complete-run', 2, /<name>=<source>/],
      [[dataDir, taskId, 'R-001'], 'fail-run', 2, /--reason 가 필요하다/],
      [[dataDir, taskId, 'R-001', '--reason', 'x'], 'fail-run', 1, /R-001 가 없다/],
    ];
    for (const [args, name, status, reason] of cases) {
      const before = contentSnapshot(dataDir);
      const r = entry.run(name, args);
      expect(r.status, `${name} ${args.join(' ')}\n${r.all}`).toBe(status);
      expect(r.stderr).toMatch(reason);
      expect(contentSnapshot(dataDir)).toEqual(before);
    }
  });
});
