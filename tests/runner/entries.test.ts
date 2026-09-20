import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { expect, it } from 'vitest';
import { entryRunner } from '../entry-helpers.js';
import { ready, spec } from './helpers.js';
import { event, step } from '../store/records.js';
import { REPO_ROOT } from '../store/paths.js';

const entry = entryRunner('worker');
it('execution entry resolves file settings and reports their logical sources', () => {
  const global = entry.file(stringify({ roles: { worker: { timeout_seconds: 20 } } }));
  const project = entry.file(stringify({ execution: { defaults: { timeout_seconds: 30 } } }));
  const request = entry.file(JSON.stringify({ action: 'settings', role: 'worker' }));
  const result = entry.run('execution', [join(entry.inputs, 'unused-data'), request, '--runner-dir', join(entry.inputs, 'unused-runner'), '--config', global, '--project-config', project]);
  expect(result.status, result.all).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ values: { backend: 'fake', timeout_seconds: 30 }, sources: { timeout_seconds: 'project.defaults' } });
});

it('execution entry creates an Intake draft and reads it in another process', () => {
  const args = [join(entry.inputs, 'intake-data')], options = ['--runner-dir', join(entry.inputs, 'intake-runner'), '--actor', 'human:tester'];
  const created = entry.run('execution', [...args, entry.file(JSON.stringify({ action: 'intake-create', text: '새 작업을 정의하자' })), ...options]);
  expect(created.status, created.all).toBe(0);
  const draft = JSON.parse(created.stdout);
  const result = entry.run('execution', [...args, entry.file(JSON.stringify({ action: 'intake-status', id: draft.id })), ...options]);
  expect(result.status, result.all).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ collected: true, draft: { id: draft.id, phase: 'intent', revision: 1 } });
});

it('submit/status/collect entrypoints recover through independent Node processes', async () => {
  const url = 'https://example.invalid/runner-test.git';
  const s = await ready(url);
  writeFileSync(join(s.dataDir, 'projects.yaml'), stringify({ projects: { sample: { repo: url } } }));
  const machine = join(s.root, 'machine.yaml');
  writeFileSync(machine, stringify({ projects: { sample: { clone: s.clone, worktree_root: s.worktreeRoot } } }));
  const file = entry.file(JSON.stringify(spec('success', 400)));
  const submit = [s.dataDir, s.task.id, 'step-001', 'R-001', file, '--runner-dir', s.runnerDir, '--machine-config', machine];
  const first = entry.run('submit-worker', submit);
  expect(first.status, first.all).toBe(0);
  const args = [s.dataDir, s.task.id, 'R-001', '--runner-dir', s.runnerDir];
  const status = entry.run('worker-status', args);
  expect(status.status, status.all).toBe(0);
  expect(['running', 'completed']).toContain(JSON.parse(status.stdout).execution.state);
  let result = entry.run('collect-worker', args);
  for (let n = 0; n < 5 && !JSON.parse(result.stdout).collected; n++) result = entry.run('collect-worker', args);
  expect(result.status, result.all).toBe(0);
  expect(JSON.parse(result.stdout).run.status).toBe('completed');
  const repeated = entry.run('submit-worker', submit);
  expect(repeated.status, repeated.all).toBe(0);
  expect(JSON.parse(repeated.stdout).collected).toBe(true);
  expect(entry.run('collect-worker', args).stdout).toBe(result.stdout);
  const bad = entry.file(JSON.stringify(spec('fail')));
  const changed = entry.run('submit-worker', [s.dataDir, s.task.id, 'step-001', 'R-001', bad, '--runner-dir', s.runnerDir, '--machine-config', machine]);
  expect(changed.status).toBe(1);
  expect(changed.stderr).toContain('different input');
  expect(changed.stderr).not.toContain('아무것도 기록하지 않았다');
});

it.each([
  ['claude-code', 'claude', '@anthropic-ai/claude-code'], ['codex', 'codex', '@openai/codex'], ['opencode', 'opencode', 'opencode-ai'],
])('%s CLI entry explicitly selects its adapter (controlled executable)', async (backend, bin, pkg) => {
  const url = 'https://example.invalid/runner-entry.git';
  const s = await ready(url);
  await s.store.commit(s.task.id, { writes: [{ kind: 'step', value: { ...step(s.task.id, 'step-001'), outputs: [{ name: 'plan', type: 'document' }] } }], events: [event('step.defined', { step_id: 'step-001' })] });
  writeFileSync(join(s.dataDir, 'projects.yaml'), stringify({ projects: { sample: { repo: url } } }));
  const machine = join(s.root, 'machine.yaml');
  writeFileSync(machine, stringify({ projects: { sample: { clone: s.clone, worktree_root: s.worktreeRoot } } }));
  // Exercise Windows npm-bin resolution without installing anything or using a shell.
  const binDir = join(s.root, 'bins'); const pkgDir = join(binDir, 'node_modules', pkg);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ bin: { [bin!]: 'cli.mjs' } }));
  const program = `#!/usr/bin/env node\nprocess.argv.splice(2, 0, ${JSON.stringify(backend)}); await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'tests/runner/fixtures/cli.mjs')).href)});\n`;
  writeFileSync(join(pkgDir, 'cli.mjs'), program);
  if (process.platform !== 'win32') writeFileSync(join(binDir, bin!), program, { mode: 0o755 });
  const env = { PATH: `${binDir}${delimiter}${process.env.PATH}` };
  const file = entry.file(JSON.stringify({ backend, model: 'provider/model', prompt: '{}', artifacts: [{ name: 'plan', source: 'blob:work-notes' }] }));
  const args = [s.dataDir, s.task.id, 'R-001', '--runner-dir', s.runnerDir, '--backend', backend!];
  const submitted = entry.run('submit-worker', [s.dataDir, s.task.id, 'step-001', 'R-001', file, '--machine-config', machine, ...args.slice(3)], env);
  expect(submitted.status, submitted.all).toBe(0);
  expect(JSON.parse(submitted.stdout).run).toMatchObject({ backend, backend_version: '9.8.7', model: 'provider/model' });
  expect(entry.run('worker-status', args, env).status).toBe(0);
  let result = entry.run('collect-worker', args, env);
  for (let n = 0; n < 5 && !JSON.parse(result.stdout).collected; n++) result = entry.run('collect-worker', args, env);
  expect(result.status, result.all).toBe(0);
  expect(JSON.parse(result.stdout).run.status).toBe('completed');
  expect(entry.run('collect-worker', args, env).stdout).toBe(result.stdout);
  expect(entry.run('worker-status', [...args.slice(0, -1), 'fake'], env).status).toBe(1);
});
