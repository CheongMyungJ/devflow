import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, mkdir, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { QuestionRequest } from '../types.js';
import type { CliCommand } from '../local/adapter.js';
import { validateCodexModelSettings } from './settings.js';

/** Separate from exec/managed launch. No writable output directory, resume, MCP, apps or project hooks. */
export function questionArgs(dir: string, model?: string, reasoning?: string): string[] {
  validateCodexModelSettings({ ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) });
  return ['--sandbox', 'read-only', '--ask-for-approval', 'never',
    '--config', 'windows.sandbox="elevated"', '--config', 'features.apps=false',
    '--config', 'features.plugins=false', '--config', 'features.remote_plugin=false', '--config', 'features.hooks=false',
    '--config', 'features.skip_host_skill_discovery=true', '--config', 'features.skill_mcp_dependency_install=false',
    '--config', 'memories.use_memories=false', '--config', 'memories.generate_memories=false',
    '--config', 'project_doc_max_bytes=0', '--cd', dir, ...(model ? ['--model', model] : []),
    ...(reasoning ? ['--config', `model_reasoning_effort=${JSON.stringify(reasoning)}`] : []),
    'Read snapshot.json in this directory. It contains the initial question and the immutable result snapshot as of question handoff. Answer using only that snapshot. It is a new question session, not the original role session; unrecorded reasoning is unavailable. Source files are represented by path and base64 bytes inside the snapshot. Do not inspect the live Task worktree or State Store. Requests for changes must go through devflow revision requests. This conversation and its exit never approve a result.'];
}

export interface QuestionTerminal { launch(cli: CliCommand, args: string[], cwd: string, env?: Record<string, string>): Promise<void> }

/** Windows creates a new visible console for the interactive CLI. Resolve after spawn only. */
export const windowsQuestionTerminal: QuestionTerminal = {
  async launch(cli, args, cwd, env = {}) {
    if (process.platform !== 'win32') throw new Error('Independent question terminal is supported only on Windows');
    await writeFile(join(cwd, 'launch.json'), JSON.stringify({ command: cli.command, args: [...(cli.prefixArgs ?? []), ...args], env }), { flag: 'wx' });
    const bridge = join(cwd, 'terminal.cjs');
    await writeFile(bridge, "const fs=require('node:fs'),path=require('node:path');const plan=JSON.parse(fs.readFileSync(path.join(__dirname,'launch.json'),'utf8'));require('node:child_process').spawn(plan.command,plan.args,{cwd:__dirname,env:{...process.env,...plan.env},stdio:'inherit',shell:false}).on('error',error=>{process.stderr.write(error.message+'\\n');process.exitCode=1;});\n", { flag: 'wx' });
    const script = join(cwd, 'question.ps1');
    const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
    // A Node bridge preserves argv exactly; Windows PowerShell would strip embedded TOML quotes.
    await writeFile(script, `$ErrorActionPreference = 'Stop'\n& ${literal(process.execPath)} ${literal(bridge)}\n`, { flag: 'wx' });
    // Wait only for Start-Process to hand off a new console, never for the interactive shell/CLI.
    const command = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'powershell.exe' -WorkingDirectory ${literal(cwd)} -ArgumentList ${literal(`-NoLogo -NoProfile -ExecutionPolicy Bypass -File "${script}"`)} | Out-Null`;
    await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
  },
};

export async function openCodexQuestion(root: string, cli: CliCommand, version: string, request: QuestionRequest, terminal = windowsQuestionTerminal) {
  // This contract was inspected against 0.154.0; fail closed for unverified versions/platforms.
  if (version !== '0.154.0' || process.platform !== 'win32') throw new Error('Read-only question handoff requires verified Windows Codex CLI 0.154.0');
  validateCodexModelSettings(request);
  const workdir = await realpath(request.workdir);
  const isInside = (path: string) => { const rel = relative(workdir, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
  if (isInside(resolve(root))) throw new Error('Question storage must be outside the Task worktree');
  await mkdir(resolve(root), { recursive: true });
  if (isInside(await realpath(root))) throw new Error('Question storage resolves inside the Task worktree');
  const parent = resolve(root, 'questions'); await mkdir(parent, { recursive: true });
  if (isInside(await realpath(parent))) throw new Error('Question storage resolves inside the Task worktree');
  const dir = await mkdtemp(join(parent, 'snapshot-'));
  const nativeHome = await mkdtemp(join(parent, 'codex-home-'));
  // Child-only native configuration directory. Never copy credentials, config, rules, plugins or sessions.
  await writeFile(join(nativeHome, 'config.toml'), 'sandbox_mode = "read-only"\napproval_policy = "never"\n[windows]\nsandbox = "elevated"\n', { flag: 'wx' });
  const file = join(dir, 'snapshot.json');
  await writeFile(file, JSON.stringify({ notice: '질문 시점의 결과 기준 · 읽기 전용 · 답변/종료는 승인 아님', id: request.id, question: request.question, context: JSON.parse(request.context) }, null, 2), { flag: 'wx', mode: 0o444 });
  await chmod(file, 0o444);
  await terminal.launch(cli, questionArgs(dir, request.model, request.reasoning), dir, { CODEX_HOME: nativeHome });
  // Deliberately no process handle, exit listener, answer collection, or cleanup tied to CLI lifetime.
}
