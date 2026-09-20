import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionError, type QuestionRequest } from '../types.js';
import type { CliCommand } from '../local/adapter.js';
import { prepareQuestion, questionPrompt, windowsQuestionTerminal } from '../local/question.js';

/** OpenCode 1.x official CLI/config/agents guides. Documentation-based; not runtime verified. */
export async function openOpenCodeQuestion(root: string, cli: CliCommand, request: QuestionRequest, terminal = windowsQuestionTerminal) {
  if (process.platform !== 'win32') throw new ExecutionError('Independent question terminal is supported only on Windows');
  if (request.model && !/^[^/\s]+\/[^\s]+$/.test(request.model)) throw new ExecutionError('OpenCode model must be provider/model');
  // The TUI guide has no --variant flag. Use the documented agent option, not the run-only flag.
  if (request.reasoning && (!request.model?.startsWith('openai/') || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(request.reasoning))) {
    throw new ExecutionError('OpenCode question reasoning uses documented OpenAI reasoningEffort; specify openai/model and a supported effort, or omit reasoning for other providers');
  }
  const { dir, nativeHome } = await prepareQuestion(root, request, 'opencode');
  const configDir = join(nativeHome, '.config', 'opencode');
  await mkdir(configDir, { recursive: true });
  const permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', external_directory: 'deny' };
  const config = JSON.stringify({ share: 'disabled', autoupdate: false, snapshot: false, formatter: false, lsp: false,
    default_agent: 'devflow-question', permission,
    agent: {
      build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true }, scout: { disable: true },
      'devflow-question': { description: 'Answer questions about a frozen devflow result', mode: 'primary',
        prompt: questionPrompt, permission, ...(request.model ? { model: request.model } : {}),
        ...(request.reasoning ? { reasoningEffort: request.reasoning } : {}) },
    } });
  const configPath = join(configDir, 'opencode.json');
  await writeFile(configPath, config, { flag: 'wx' });
  await terminal.launch(cli, [dir, '--pure', '--agent', 'devflow-question',
    ...(request.model ? ['--model', request.model] : []), '--prompt', questionPrompt], dir, {
    // Child-only home/config/data paths; never copy user configuration, credentials or sessions.
    HOME: nativeHome, USERPROFILE: nativeHome, XDG_CONFIG_HOME: join(nativeHome, '.config'),
    XDG_DATA_HOME: join(nativeHome, 'data'), XDG_CACHE_HOME: join(nativeHome, 'cache'), XDG_STATE_HOME: join(nativeHome, 'state'),
    OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG_CONTENT: config,
    OPENCODE_PERMISSION: JSON.stringify(permission), OPENCODE_AUTO_SHARE: 'false', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
  });
}
