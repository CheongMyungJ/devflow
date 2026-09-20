import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openClaudeQuestion, questionArgs } from '../../src/runner/claude-code/question.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code/runner.js';
import { tempDataDir } from '../store/helpers.js';

describe('independent Claude Code question adapter', () => {
  it('provides only read tools in restricted interactive mode without permission prompts or extensions', () => {
    const args = questionArgs('sonnet', 'high');
    for (const option of ['--safe-mode', '--restricted', '--disable-slash-commands', '--no-chrome']) expect(args).toContain(option);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value('--tools')).toBe('Read,Glob,Grep');
    expect(value('--allowedTools')).toBe('Read,Glob,Grep');
    expect(value('--disallowedTools')).toBe('mcp__*');
    expect(value('--permission-mode')).toBe('dontAsk');
    expect(value('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(value('--model')).toBe('sonnet'); expect(value('--effort')).toBe('high');
    for (const option of ['--print', '--permission-prompts', '--add-dir', '--resume', '--continue']) expect(args).not.toContain(option);
    expect(args.at(-1)).toContain('snapshot.json');
  });

  it('rejects unsupported reasoning before preparing local files', async () => {
    const root = tempDataDir();
    expect(() => questionArgs(undefined, 'high')).toThrow(/unsupported/);
    expect(() => questionArgs('sonnet', 'max')).toThrow(/unsupported/);
    expect(() => questionArgs('opus', 'invalid')).toThrow(/unsupported/);
    expect(questionArgs('opus', 'max')).toContain('max');
    if (process.platform === 'win32') await expect(openClaudeQuestion(root, { command: 'unused' }, '2.1.278', {
      id: 'q', workdir: root, question: '?', context: '{}', reasoning: 'high',
    })).rejects.toThrow(/unsupported/);
    expect(await readdir(root)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('hands off frozen input with a fresh config directory and no managed run', async () => {
    const root = tempDataDir(), workdir = join(root, 'worktree'); await mkdir(workdir);
    let launched = false;
    await openClaudeQuestion(join(root, 'runner'), { command: 'claude.exe' }, '2.1.278', {
      id: 'q', workdir, question: 'Explain', context: '{"artifact":"artifact://T-0001/step-001/report@v3"}', model: 'sonnet', reasoning: 'medium',
    }, { async launch(cli, args, cwd, env) {
      launched = true;
      expect(cli.command).toBe('claude.exe'); expect(args).not.toContain(workdir);
      expect(await readdir(cwd)).toEqual(['snapshot.json']);
      const snapshot = JSON.parse(await readFile(join(cwd, 'snapshot.json'), 'utf8'));
      expect(snapshot.context.artifact).toMatch(/@v3$/); expect(snapshot.question).toBe('Explain');
      expect(env?.CLAUDE_CONFIG_DIR).not.toBe(process.env.CLAUDE_CONFIG_DIR);
      expect(await readdir(env!.CLAUDE_CONFIG_DIR!)).toEqual([]);
      expect(env?.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium');
    } });
    expect(launched).toBe(true);
    expect(await readdir(workdir)).toEqual([]);
    expect(await readdir(join(root, 'runner'))).toEqual(['questions']);
  });

  it.runIf(process.platform === 'win32')('rejects storage in the worktree and returns terminal failure to the caller', async () => {
    const root = tempDataDir(), workdir = join(root, 'worktree'); await mkdir(workdir);
    const request = { id: 'q', workdir, question: '?', context: '{}' };
    const terminal = { async launch() { throw new Error('terminal unavailable'); } };
    await expect(openClaudeQuestion(join(workdir, 'runner'), { command: 'unused' }, '2.1.278', request, terminal)).rejects.toThrow(/outside/);
    await expect(openClaudeQuestion(join(root, 'runner'), { command: 'unused' }, '2.1.278', request, terminal)).rejects.toThrow(/terminal unavailable/);
  });

  it('connects the public Runner method and rejects incompatible versions before launch', async () => {
    const root = tempDataDir();
    const runner = new ClaudeCodeRunner(root, { command: process.execPath, prefixArgs: ['-e', 'console.log("0.0.0")'] });
    await expect(runner.openQuestion({ id: 'q', workdir: root, question: '?', context: '{}' })).rejects.toThrow(/2.1.278/);
    expect(await readdir(root)).toEqual([]);
  });
});
