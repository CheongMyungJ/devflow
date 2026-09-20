import { join } from 'node:path';
import { LocalRunner } from '../local/runner.js';
import { cliVersion, resolveCli } from '../local/cli.js';
import { workerPrompt } from '../local/prompt.js';
import type { CliCommand } from '../local/adapter.js';

export class ClaudeCodeRunner extends LocalRunner {
  constructor(root: string, cli: CliCommand = resolveCli('claude', '@anthropic-ai/claude-code')) {
    super(root, { id: 'claude-code', version: cliVersion(cli),
      launch(request, dir) {
        const outputPath = join(dir, 'output', 'worker-output.json');
        return { command: cli.command, args: [...(cli.prefixArgs ?? []), '--print', '--input-format', 'text',
          '--output-format', 'text', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
          '--no-session-persistence', '--add-dir', join(dir, 'output'),
          ...(request.model ? ['--model', request.model] : [])],
          stdin: workerPrompt(request.prompt, outputPath), env: {}, outputPath };
      },
    });
  }
}
