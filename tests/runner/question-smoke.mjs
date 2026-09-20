// Explicit opt-in: opens one short-lived Windows console and exercises the installed sandbox.
// No model call, conversation capture, or native question CLI exit management.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBuild } from '../../scripts/lib/build.mjs';

if (process.platform !== 'win32') throw new Error('Windows question handoff smoke only');
const { dir } = prepareBuild();
const load = relative => import(pathToFileURL(join(dir, relative)).href);
const { windowsQuestionTerminal, questionArgs } = await load('src/runner/codex/question.js');
const { resolveCli, cliVersion } = await load('src/runner/local/cli.js');
const root = mkdtempSync(join(tmpdir(), 'devflow-question-smoke-'));
const question = join(root, 'question'), worktree = join(root, 'task-worktree'), store = join(root, 'store');
for (const path of [question, worktree, store]) mkdirSync(path);
const paths = [join(question, 'snapshot.json'), join(worktree, 'artifact.txt'), join(store, 'state.txt')];
for (const path of paths) writeFileSync(path, 'fixed bytes\n');
const cli = resolveCli('codex', '@openai/codex'), version = cliVersion(cli);
if (version !== '0.154.0') throw new Error(`Unverified Codex version ${version}`);
const nativeHome = join(root, 'native-home'); mkdirSync(nativeHome);
writeFileSync(join(nativeHome, 'config.toml'), 'sandbox_mode = "read-only"\napproval_policy = "never"\n');
const isolatedEnv = { ...process.env, CODEX_HOME: nativeHome };
const configuredAI = { model: 'gpt-5.5', reasoning: 'medium' };
execFileSync(cli.command, [...(cli.prefixArgs ?? []), ...questionArgs(question, configuredAI.model, configuredAI.reasoning), '--help'], { env: isolatedEnv, windowsHide: true, stdio: 'pipe' });
const servers = JSON.parse(execFileSync(cli.command, [...(cli.prefixArgs ?? []), '--config', 'features.plugins=false', '--config', 'features.apps=false', 'mcp', 'list', '--json'], { env: isolatedEnv, encoding: 'utf8', windowsHide: true }));
if (servers.length) throw new Error('Native question home unexpectedly inherited MCP servers');
const probe = join(question, 'write-probe.cjs');
writeFileSync(probe, `const fs=require('fs'); const result=${JSON.stringify(paths)}.map(path=>{try{fs.appendFileSync(path,'changed');return {blocked:false};}catch(error){return {blocked:true,code:error.code};}});console.log(JSON.stringify(result));`);
const stdout = execFileSync(cli.command, [...(cli.prefixArgs ?? []), 'sandbox',
  '--permission-profile', 'devflow_question_probe', '--include-managed-config',
  '--config', 'permissions.devflow_question_probe.extends=":read-only"', '--config', 'windows.sandbox="elevated"', '-C', question, '--', process.execPath, probe], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
const blocked = JSON.parse(stdout.trim());
if (!blocked.every(result => result.blocked) || paths.some(path => readFileSync(path, 'utf8') !== 'fixed bytes\n')) throw new Error('Sandbox write restriction failed');

const ttyProbe = join(question, 'tty-probe.cjs'), ttyReceipt = join(root, 'tty.json');
writeFileSync(ttyProbe, `require('fs').writeFileSync(${JSON.stringify(ttyReceipt)},JSON.stringify({stdin:!!process.stdin.isTTY,stdout:!!process.stdout.isTTY,stderr:!!process.stderr.isTTY}));setTimeout(()=>{},1000);`);
const started = Date.now();
await windowsQuestionTerminal.launch({ command: process.execPath }, [ttyProbe], question);
const handoffMs = Date.now() - started;
for (let i = 0; i < 100 && !existsSync(ttyReceipt); i++) await new Promise(resolve => setTimeout(resolve, 50));
const tty = JSON.parse(readFileSync(ttyReceipt, 'utf8'));
if (!tty.stdin || !tty.stdout || !tty.stderr) throw new Error(`Interactive console handles missing: ${JSON.stringify(tty)}`);
const result = { date: new Date().toISOString(), version, blocked, tty, handoffMs, interactiveArgumentsAccepted: true, configuredAI, inheritedMcpServers: servers.length, modelConversationTested: false };
writeFileSync(join(root, 'verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ root, ...result }, null, 2));
