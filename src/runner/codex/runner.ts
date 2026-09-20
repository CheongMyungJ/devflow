import { join } from 'node:path';
import { LocalRunner } from '../local/runner.js';
import { cliVersion, resolveCli } from '../local/cli.js';
import { workerPrompt } from '../local/prompt.js';
import type { CliCommand } from '../local/adapter.js';

export class CodexRunner extends LocalRunner {
  constructor(root: string, cli: CliCommand = resolveCli('codex', '@openai/codex')) {
    super(root, { id: 'codex', version: cliVersion(cli),
      launch(request, dir) {
        const outputPath = join(dir, 'output', 'worker-output.json');
        return { command: cli.command, args: [...(cli.prefixArgs ?? []), 'exec', '--sandbox', 'workspace-write',
          '--config', 'approval_policy="never"', '--cd', request.workdir, '--add-dir', join(dir, 'output'),
          '--ephemeral', '--color', 'never', ...(request.model ? ['--model', request.model] : []), '-'],
          stdin: workerPrompt(request.prompt, outputPath), env: {}, outputPath };
      },
    });
  }
}
