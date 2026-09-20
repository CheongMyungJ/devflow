import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionError } from '../types.js';
import { LocalRunner } from '../local/runner.js';
import { cliVersion, resolveCli } from '../local/cli.js';
import { workerPrompt } from '../local/prompt.js';
import type { CliCommand } from '../local/adapter.js';
import type { QuestionRequest } from '../types.js';
import { openClaudeQuestion } from './question.js';
import { validateClaudeModelSettings } from './settings.js';

export class ClaudeCodeRunner extends LocalRunner {
  private readonly questionRoot: string;
  private readonly questionCli: CliCommand;
  constructor(root: string, cli: CliCommand = resolveCli('claude', '@anthropic-ai/claude-code')) {
    super(root, { id: 'claude-code', version: cliVersion(cli),
      capabilities: { supportsResume: false, supportsLiveMessage: true },
      validate(request) {
        validateClaudeModelSettings(request);
        if (request.isolation === 'strict') throw new ExecutionError('strict environment isolation is not verified for Claude Code; project isolation is available');
      },
      launch(request, dir) {
        const outputPath = join(dir, 'output', 'worker-output.json');
        const args = [...(cli.prefixArgs ?? []), '--print', '--safe-mode', '--input-format', 'stream-json', '--verbose',
          '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
          '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--settings', JSON.stringify({ autoMemoryEnabled: false }), '--add-dir', join(dir, 'output'),
          ...(request.access === 'read' ? ['--tools', 'Read,Glob,Grep,Write', '--allowedTools', `Write(${outputPath.replaceAll('\\', '/')})`, '--disallowedTools', `Write(${request.workdir.replaceAll('\\', '/')}/**)`] : []),
          ...(request.model ? ['--model', request.model] : []), ...(request.reasoning ? ['--effort', request.reasoning] : [])];
        return { command: cli.command, args,
          stdin: workerPrompt(request.prompt, outputPath, request.role, request.context, request.workdir), env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_EFFORT_LEVEL: request.reasoning ?? 'auto' }, outputPath,
          liveInput: request.role !== 'reviewer', protocolModule: fileURLToPath(new URL('./protocol.mjs', import.meta.url)) };
      },
    });
    this.questionRoot = root;
    this.questionCli = cli;
  }
  openQuestion(request: QuestionRequest) { return openClaudeQuestion(this.questionRoot, this.questionCli, this.version, request); }
}
