import type { QuestionRequest } from '../types.js';
import type { CliCommand } from '../local/adapter.js';
import { prepareQuestion, questionPrompt, windowsQuestionTerminal } from '../local/question.js';
import { validateClaudeModelSettings } from './settings.js';

/** Interactive flags: permission-prompts and stream input belong only to managed --print. */
export function questionArgs(model?: string, reasoning?: string): string[] {
  validateClaudeModelSettings({ ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) });
  return ['--safe-mode', '--restricted', '--tools', 'Read,Glob,Grep',
    '--allowedTools', 'Read,Glob,Grep', '--disallowedTools', 'mcp__*',
    '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome', '--settings', '{"autoMemoryEnabled":false}',
    ...(model ? ['--model', model] : []), ...(reasoning ? ['--effort', reasoning] : []), questionPrompt];
}

export async function openClaudeQuestion(root: string, cli: CliCommand, version: string, request: QuestionRequest, terminal = windowsQuestionTerminal) {
  if (version !== '2.1.278' || process.platform !== 'win32') throw new Error('Read-only question handoff requires Windows Claude Code 2.1.278');
  const args = questionArgs(request.model, request.reasoning);
  const { dir, nativeHome } = await prepareQuestion(root, request, 'claude');
  await terminal.launch(cli, args, dir, { CLAUDE_CONFIG_DIR: nativeHome,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_EFFORT_LEVEL: request.reasoning ?? 'auto' });
}
