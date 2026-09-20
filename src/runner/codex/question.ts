import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuestionRequest } from '../types.js';
import type { CliCommand } from '../local/adapter.js';
import { prepareQuestion, questionPrompt, windowsQuestionTerminal } from '../local/question.js';
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
    questionPrompt];
}

export async function openCodexQuestion(root: string, cli: CliCommand, version: string, request: QuestionRequest, terminal = windowsQuestionTerminal) {
  if (version !== '0.154.0' || process.platform !== 'win32') throw new Error('Read-only question handoff requires verified Windows Codex CLI 0.154.0');
  validateCodexModelSettings(request);
  const { dir, nativeHome } = await prepareQuestion(root, request, 'codex');
  await writeFile(join(nativeHome, 'config.toml'), 'sandbox_mode = "read-only"\napproval_policy = "never"\n[windows]\nsandbox = "elevated"\n', { flag: 'wx' });
  await terminal.launch(cli, questionArgs(dir, request.model, request.reasoning), dir, { CODEX_HOME: nativeHome });
}
