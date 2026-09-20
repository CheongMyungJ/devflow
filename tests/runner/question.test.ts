import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCodexQuestion, questionArgs } from '../../src/runner/codex/question.js';
import { tempDataDir } from '../store/helpers.js';

describe('independent Codex question adapter', () => {
  it('requires backend read-only permissions and never grants write roots or resumes a session', () => {
    const args = questionArgs('snapshot-dir', 'test-model');
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    expect(args.slice(args.indexOf('--ask-for-approval'), args.indexOf('--ask-for-approval') + 2)).toEqual(['--ask-for-approval', 'never']);
    expect(args).toContain('features.plugins=false'); expect(args).toContain('features.hooks=false');
    expect(args).not.toContain('--ignore-user-config'); // exec-only flag, invalid for interactive mode
    expect(args).not.toContain('--add-dir'); expect(args).not.toContain('exec'); expect(args).not.toContain('resume');
    expect(args.join(' ')).toContain('features.apps=false'); expect(args.at(-1)).toContain('snapshot.json');
  });

  it('passes configured model/reasoning and rejects the same unsupported combinations as managed Codex', () => {
    const args = questionArgs('snapshot-dir', 'gpt-5.5', 'high');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-5.5']);
    expect(args).toContain('model_reasoning_effort="high"');
    expect(() => questionArgs('snapshot-dir', undefined, 'high')).toThrow(/unsupported/);
    expect(() => questionArgs('snapshot-dir', 'gpt-5.5', 'unverified')).toThrow(/unsupported/);
    expect(() => questionArgs('snapshot-dir', 'other-model', 'high')).toThrow(/unsupported/);
  });

  it.runIf(process.platform === 'win32')('hands off only isolated frozen bytes and resolves before the interactive window closes', async () => {
    const root = tempDataDir(), workdir = join(root, 'worktree'); await mkdir(workdir);
    let open = false, dir = '';
    await openCodexQuestion(join(root, 'runner'), { command: 'codex.exe' }, '0.154.0', {
      id: 'question-test', workdir, question: 'Why?', model: 'gpt-5.5', reasoning: 'medium', context: JSON.stringify({ target: { artifact_refs: ['artifact://T-0001/step-001/report@v3'] }, text: 'fixed content' }),
    }, { async launch(_cli, args, cwd, env) {
      open = true; dir = cwd; expect(args).not.toContain(workdir);
      expect(args).toContain('gpt-5.5'); expect(args).toContain('model_reasoning_effort="medium"');
      expect(env?.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
      expect(await readdir(env!.CODEX_HOME!)).toEqual(['config.toml']);
    } });
    expect(open).toBe(true);
    expect(await readdir(dir)).toEqual(['snapshot.json']);
    const snapshot = JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8'));
    expect(snapshot.context.text).toBe('fixed content'); expect(snapshot.context.target.artifact_refs[0]).toMatch(/@v3$/);
    expect(snapshot.notice).toContain('질문 시점');
    expect(await readdir(workdir)).toEqual([]);
  });

  it('fails closed for unverified versions without preparing or launching a question', async () => {
    const root = tempDataDir(); let launched = false;
    await expect(openCodexQuestion(join(root, 'runner'), { command: 'codex.exe' }, '0.999.0', { id: 'q', workdir: root, question: '?', context: '{}' }, { async launch() { launched = true; } })).rejects.toThrow(/verified/);
    expect(launched).toBe(false); expect(await readdir(root)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('rejects snapshot storage inside the Task worktree and propagates handoff failure', async () => {
    const root = tempDataDir(), workdir = join(root, 'worktree'); await mkdir(workdir);
    const request = { id: 'q', workdir, question: '?', context: '{}' };
    const terminal = { async launch() { throw new Error('cannot open terminal'); } };
    await expect(openCodexQuestion(join(workdir, 'runner'), { command: 'codex' }, '0.154.0', request, terminal)).rejects.toThrow(/outside/);
    expect(await readdir(workdir)).toEqual([]);
    await expect(openCodexQuestion(join(root, 'runner'), { command: 'codex' }, '0.154.0', request, terminal)).rejects.toThrow(/cannot open terminal/);
  });
});
