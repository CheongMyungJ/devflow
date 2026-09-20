import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/runner/claude-code/runner.js';
import { CodexRunner } from '../../src/runner/codex/runner.js';
import { OpenCodeRunner } from '../../src/runner/opencode/runner.js';
import { submitWorker, collectWorker as collect } from '../../src/commands/worker.js';
import { getWorkerExecution } from '../../src/queries/worker.js';
import { executionKey, validatedOutput } from '../../src/runner/records.js';
import type { RunRequest } from '../../src/runner/types.js';
import type { WorkerExecutionInput } from '../../src/types/generated/index.js';
import { allText, containsPath } from '../entry-helpers.js';
import { newStore, tempDataDir } from '../store/helpers.js';
import { event, step } from '../store/records.js';
import { BUILD_DIR, REPO_ROOT } from '../store/paths.js';
import { runGit } from '../workspace/helpers.js';
import { ready, terminal, until } from './helpers.js';
import { sendExecutionMessage } from '../../src/commands/execution-control.js';

const collectWorker = (ctx: Parameters<typeof collect>[0], input: { taskId: string; runId: string }) => collect(ctx, { taskId: input.taskId, runId: input.runId });
const adapters = [['claude-code', ClaudeCodeRunner], ['codex', CodexRunner], ['opencode', OpenCodeRunner]] as const;
const fixture = join(REPO_ROOT, 'tests/runner/fixtures/cli.mjs');

describe.each(adapters)('%s controlled CLI contract (no model calls)', (backend, Adapter) => {
  const cli = { command: process.execPath, prefixArgs: [fixture, backend] };
  const model = backend === 'opencode' ? 'provider/model' : 'explicit-model';
  function local(input: object = {}) {
    const root = tempDataDir(); const workdir = join(root, 'space & 한글'); mkdirSync(workdir);
    const runner = new Adapter(join(root, 'runner'), cli);
    const request: RunRequest = { key: { taskId: 'T-0001', runId: 'R-001', executionId: randomUUID() },
      workspaceId: randomUUID(), workdir, role: 'worker', access: 'write', backend, model, prompt: JSON.stringify(input) };
    return { root, runner, request, dir: join(root, 'runner', 'T-0001', 'R-001', request.key.executionId) };
  }
  async function managed(input: object = {}, code = false) {
    const s = await ready();
    if (!code) await s.store.commit(s.task.id, { writes: [{ kind: 'step', value: { ...step(s.task.id, 'step-001'), outputs: [{ name: 'plan', type: 'document' }] } }], events: [event('step.defined', { step_id: 'step-001' })] });
    const runner = new Adapter(s.runnerDir, cli);
    const spec: WorkerExecutionInput = { backend, model, prompt: JSON.stringify(input), artifacts: [
      { name: 'plan', source: 'blob:work-notes' }, ...(code ? [{ name: 'change', source: 'workspace:code' }] : []),
    ] };
    return { ...s, runner, ctx: { ...s.ctx, runner }, input: { ...s.input, input: spec } };
  }

  it('argv, stdin, cwd, explicit model, safe policy, delay, independent identity and no duplicate start', async () => {
    const s = local({ delayMs: 800, literal: 'quotes " $(no shell) ` & 한글\nline' });
    await s.runner.prepare(s.request);
    const overlap = await Promise.allSettled([s.runner.submit(s.request), s.runner.submit(s.request)]);
    expect(overlap.some(r => r.status === 'fulfilled')).toBe(true);
    expect((await s.runner.inspect(s.request.key)).state).toBe('running');
    await until(async () => existsSync(join(s.dir, 'invocation.json')), Boolean);
    const invocation = readFileSync(join(s.dir, 'invocation.json'), 'utf8');
    const seen = JSON.parse(invocation);
    expect(seen.cwd).toBe(s.request.workdir);
    expect(seen.stdin).toContain(s.request.prompt);
    expect(seen.args).toEqual(expect.arrayContaining(['--model', model]));
    expect(seen.args.join(' ')).not.toMatch(/bypass|danger|--auto|resume|--continue|--output-schema|--json-schema/);
    if (backend === 'claude-code') expect(seen.args).toEqual(expect.arrayContaining(['--print', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none']));
    if (backend === 'codex') expect(seen.args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'workspace-write', '--cd', s.request.workdir, '-']));
    if (backend === 'opencode') {
      expect(seen.args).toEqual(expect.arrayContaining(['run', '--agent', 'build', '--dir', s.request.workdir]));
      expect(JSON.parse(seen.config).permission['*']).toBe('ask');
    }
    await expect(s.runner.prepare({ ...s.request, model: 'other/model' })).rejects.toThrow(/different input/);
    await expect(s.runner.submit({ ...s.request, prompt: '{}' })).rejects.toThrow(/different input/);
    const other = { ...s.request, key: { ...s.request.key, taskId: 'T-0002' } };
    await s.runner.prepare(other); await s.runner.submit(other);
    await until(() => s.runner.inspect(other.key), terminal);
    await until(() => s.runner.inspect(s.request.key), terminal);
    expect((await s.runner.submit(s.request)).state).toBe('completed');
    expect(readFileSync(join(s.dir, 'invocation.json'), 'utf8')).toBe(invocation);
    expect(s.runner.version).toBe('9.8.7');
    for (const patch of [{ access: 'read' }, { resume: 'old' }, { role: 'reviewer' }]) {
      await expect(s.runner.prepare({ ...s.request, ...patch } as RunRequest)).rejects.toThrow(/unsupported/);
    }
  });

  it.each([
    [{ mode: 'fail' }, 'process_exit'], [{ output: 'not JSON' }, 'invalid_output'],
    [{ output: '{"summary":"missing required field"}' }, 'invalid_output'],
    [{ mode: 'missing' }, 'invalid_output'], [{ mode: 'stdout' }, 'invalid_output'],
  ])('confirmed failure %j is %s; logs never substitute for output', async (input, kind) => {
    const s = managed(input); const m = await s;
    const first = await submitWorker(m.ctx, m.input);
    await until(() => m.runner.inspect(executionKey(first.run)), terminal);
    expect((await getWorkerExecution(m.ctx, m.input)).execution).toMatchObject({ state: 'failed', kind });
    expect((await collectWorker(m.ctx, m.input)).run).toMatchObject({ status: 'failed', failure_kind: kind });
    const before = allText(m.dataDir);
    await collectWorker(m.ctx, m.input);
    expect(allText(m.dataDir)).toBe(before);
    expect((await m.store.list('artifact', { taskId: m.task.id })).items).toHaveLength(0);
  });

  it('missing executable is a confirmed process failure', async () => {
    const s = local(); const runner = new Adapter(join(s.root, 'runner'), { command: join(s.root, 'missing-executable') });
    await runner.prepare(s.request); await runner.submit(s.request);
    expect(await until(() => runner.inspect(s.request.key), terminal)).toMatchObject({ state: 'failed', kind: 'process_exit' });
  });

  it('retries malformed output only after exit, preserving local evidence', async () => {
    const s = local({ invalidFirst: true });
    s.request.output_retries = 1;
    await s.runner.prepare(s.request); await s.runner.submit(s.request);
    expect(await until(() => s.runner.inspect(s.request.key), terminal)).toMatchObject({ state: 'completed', outputAttempts: 2 });
    expect(readFileSync(join(s.dir, 'invalid-output-1.json'), 'utf8')).toBe('not JSON');
    expect(existsSync(join(s.dir, 'invocation-2.json'))).toBe(true);
  });

  it('accepts read roles with an explicit output contract and restricted workspace writes', async () => {
    const output = JSON.stringify({ after_step: null, action: 'ask_human', rationale: 'Review scope', question: { text: 'Which scope?' }, packet_gaps: [] });
    const s = local({ output }); s.request.role = 'planner'; s.request.access = 'read';
    await s.runner.prepare(s.request); await s.runner.submit(s.request);
    expect(await until(() => s.runner.inspect(s.request.key), terminal)).toMatchObject({ state: 'completed' });
    const seen = JSON.parse(readFileSync(join(s.dir, 'invocation.json'), 'utf8'));
    expect(seen.stdin).toContain('devflow/step.schema.json');
    expect(seen.stdin).toContain('Read-only role');
    if (backend === 'claude-code') expect(seen.args).toEqual(expect.arrayContaining(['--tools', 'Read,Glob,Grep,Write', '--disallowedTools']));
    if (backend === 'codex') {
      expect(seen.args).toContain('default_permissions="devflow_read"');
      expect(seen.args).not.toContain('--sandbox');
    }
    if (backend === 'opencode') expect(JSON.parse(seen.config).permission.edit['*']).toBe('deny');
  });

  it('records human messages before delivery, with one message per ID', async () => {
    const s = await managed({ waitMessage: backend === 'claude-code', delayMs: 800 });
    const first = await submitWorker(s.ctx, s.input);
    const messageId = randomUUID(), text = '질문 대신 변경된 기준을 확인해 주세요';
    const message = { taskId: s.task.id, runId: first.run.id, messageId, text };
    if (backend !== 'claude-code') {
      await expect(sendExecutionMessage(s.ctx, message)).rejects.toThrow(/does not support/);
      expect((await s.store.readEvents(s.task.id)).filter(e => e.type === 'run.message_sent')).toHaveLength(0);
    } else {
      const original = s.runner.message.bind(s.runner);
      s.runner.message = async (key, input) => {
        expect((await s.store.readEvents(s.task.id)).filter(e => e.type === 'run.message_sent')).toEqual([expect.objectContaining({ data: expect.objectContaining({ text, request_id: messageId }) })]);
        return original(key, input);
      };
      await sendExecutionMessage(s.ctx, message);
      expect(await until(() => sendExecutionMessage(s.ctx, message), result => result.delivered)).toMatchObject({ delivered: true });
      await expect(sendExecutionMessage(s.ctx, { ...message, text: 'different' })).rejects.toThrow(/different text/);
    }
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    if (backend === 'claude-code') {
      const dir = join(s.runnerDir, s.task.id, first.run.id, first.run.execution!.id);
      expect(JSON.parse(readFileSync(join(dir, 'observed-message.json'), 'utf8')).message.content).toBe(text);
      expect((await s.runner.logs(executionKey(first.run))).text).toContain('fixture-session');
    }
  });

  it('preserves commit/staged/unstaged/untracked files and collects exactly once', async () => {
    const s = await managed({ delayMs: 150 }); const cwd = s.prepared.location.workdir;
    writeFileSync(join(cwd, 'committed.txt'), 'user commit'); runGit(cwd, 'add', '.'); runGit(cwd, 'commit', '-m', 'user commit');
    writeFileSync(join(cwd, 'tracked.txt'), 'user unstaged');
    writeFileSync(join(cwd, 'staged.txt'), 'user staged'); runGit(cwd, 'add', 'staged.txt');
    writeFileSync(join(cwd, 'untracked.txt'), 'user untracked');
    const before = [runGit(cwd, 'rev-parse', 'HEAD'), runGit(cwd, 'status', '--porcelain'), runGit(cwd, 'diff'), runGit(cwd, 'diff', '--cached')];
    const first = await submitWorker(s.ctx, s.input);
    await expect(submitWorker(s.ctx, { ...s.input, input: { ...s.input.input, model: 'other/model' } })).rejects.toThrow(/different input/);
    await expect(submitWorker(s.ctx, { ...s.input, input: { ...s.input.input, backend: 'fake' } })).rejects.toThrow(/backend/);
    await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    const result = await collectWorker(s.ctx, s.input);
    expect(result.run).toMatchObject({ status: 'completed', backend, model, backend_version: '9.8.7' });
    const data = allText(s.dataDir);
    await collectWorker(s.ctx, s.input); await submitWorker(s.ctx, s.input);
    expect(allText(s.dataDir)).toBe(data); expect(containsPath(data, s.root)).toBe(false);
    expect([runGit(cwd, 'rev-parse', 'HEAD'), runGit(cwd, 'status', '--porcelain'), runGit(cwd, 'diff'), runGit(cwd, 'diff', '--cached')]).toEqual(before);
    expect((await s.store.readEvents(s.task.id)).filter(e => e.type === 'artifact.version_added')).toHaveLength(1);
  });

  it('captures actual committed SHA at exit, independent of later HEAD movement', async () => {
    const s = await managed({ commit: true }, true);
    await expect(submitWorker(s.ctx, { ...s.input, input: { ...s.input.input, artifacts: [
      { name: 'plan', source: 'blob:work-notes' }, { name: 'change', source: `code:${s.initial}..${s.initial}` },
    ] } })).rejects.toThrow(/preclaimed SHA/);
    const first = await submitWorker(s.ctx, s.input);
    const result = await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    expect(validatedOutput(result).state).toBe('completed');
    const cwd = s.prepared.location.workdir; const head = runGit(cwd, 'rev-parse', 'HEAD');
    expect(head).not.toBe(s.initial);
    writeFileSync(join(cwd, 'later.txt'), 'later'); runGit(cwd, 'add', 'later.txt'); runGit(cwd, 'commit', '-m', 'after execution');
    const collected = await collectWorker(s.ctx, s.input);
    expect(collected.artifacts?.find(a => a.name === 'change')?.code).toMatchObject({ head_sha: head, base_sha: s.initial });
    expect(collected.run.status).toBe('completed');
  });

  it('uncommitted code is preserved and never registered as a committed artifact', async () => {
    const s = await managed({}, true); const cwd = s.prepared.location.workdir;
    writeFileSync(join(cwd, 'tracked.txt'), 'not committed');
    const first = await submitWorker(s.ctx, s.input); await until(() => s.runner.inspect(executionKey(first.run)), terminal);
    expect((await collectWorker(s.ctx, s.input)).run).toMatchObject({ status: 'failed', failure_kind: 'invalid_output' });
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf8')).toBe('not committed');
  });

  it('missing/damaged evidence and launch ambiguity remain unknown without a replacement', async () => {
    const s = local(); await s.runner.prepare(s.request);
    const missing = new Adapter(join(s.root, 'other-machine'), cli);
    expect((await missing.submit(s.request)).state).toBe('unknown');
    mkdirSync(join(s.dir, 'launch-claim'));
    expect((await s.runner.submit(s.request)).state).toBe('unknown');
    writeFileSync(join(s.dir, 'result.json'), '{');
    expect((await s.runner.inspect(s.request.key)).state).toBe('unknown');
    expect(existsSync(join(s.dir, 'invocation.json'))).toBe(false);
    writeFileSync(join(s.dir, 'request.json'), 'null');
    expect((await s.runner.inspect(s.request.key)).state).toBe('unknown');
  });

  it('corrupt launch plan cannot start a prepared Worker', async () => {
    const s = local(); await s.runner.prepare(s.request);
    writeFileSync(join(s.dir, 'launch.json'), 'null');
    expect((await s.runner.submit(s.request)).state).toBe('unknown');
    expect(existsSync(join(s.dir, 'launch-claim'))).toBe(false);
    expect(existsSync(join(s.dir, 'invocation.json'))).toBe(false);
  });

  it('output before exit is running; supervisor loss is unknown even with valid output', async () => {
    const s = local({ earlyOutput: true, delayMs: 1200 }); await s.runner.prepare(s.request); await s.runner.submit(s.request);
    await until(async () => existsSync(join(s.dir, 'output', 'worker-output.json')), Boolean);
    expect((await s.runner.inspect(s.request.key)).state).toBe('running');
    const pid = JSON.parse(readFileSync(join(s.dir, 'supervisor.json'), 'utf8')).pid;
    process.kill(pid, 'SIGKILL');
    await until(() => s.runner.inspect(s.request.key), state => state.state === 'unknown');
    expect((await s.runner.submit(s.request)).state).toBe('unknown');
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(existsSync(join(s.dir, 'result.json'))).toBe(false);
  });

  it('SIGKILL caller during execution; fresh Store/Runner recovers without model restart', async () => {
    const s = await managed({ delayMs: 2500 });
    const child = spawn(process.execPath, [join(REPO_ROOT, 'tests/runner/fixtures/caller.mjs'), JSON.stringify({
      build: BUILD_DIR, dataDir: s.dataDir, runnerDir: s.runnerDir, remote: s.remote, clone: s.clone,
      worktreeRoot: s.worktreeRoot, input: s.input, phase: 'running', backend, cli,
    })], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    let stderr = ''; child.stderr.on('data', c => { stderr += c; });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`checkpoint timeout ${stderr}`)), 15000);
        child.stdout.on('data', c => { if (String(c).includes('checkpoint')) { clearTimeout(timer); resolve(); } });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
      });
      child.kill('SIGKILL'); await exited;
      const ctx = { ...s.ctx, store: newStore(s.dataDir), runner: new Adapter(s.runnerDir, cli) };
      const observed = await getWorkerExecution(ctx, s.input); expect(observed.execution.state).toBe('running');
      expect((await submitWorker(ctx, s.input)).run.execution).toEqual(observed.run.execution);
      await until(() => ctx.runner.inspect(executionKey(observed.run)), terminal);
      expect((await collectWorker(ctx, s.input)).run.status).toBe('completed');
      const before = allText(s.dataDir); await collectWorker(ctx, s.input); expect(allText(s.dataDir)).toBe(before);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
  });
});
