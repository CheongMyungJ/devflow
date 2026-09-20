import { join } from 'node:path';
import { ExecutionError } from '../types.js';
import { LocalRunner } from '../local/runner.js';
import { cliVersion, resolveCli } from '../local/cli.js';
import { workerPrompt } from '../local/prompt.js';
import type { CliCommand } from '../local/adapter.js';

export class OpenCodeRunner extends LocalRunner {
  constructor(root: string, cli: CliCommand = resolveCli('opencode', 'opencode-ai')) {
    super(root, { id: 'opencode', version: cliVersion(cli),
      validate(request) {
        if (request.model && !/^[^/\s]+\/[^\s]+$/.test(request.model)) throw new ExecutionError('OpenCode model must be provider/model');
      },
      launch(request, dir) {
        const outputPath = join(dir, 'output', 'worker-output.json');
        return { command: cli.command, args: [...(cli.prefixArgs ?? []), 'run', '--dir', request.workdir,
          '--agent', 'build', ...(request.model ? ['--model', request.model] : [])],
          stdin: workerPrompt(request.prompt, outputPath), outputPath,
          env: { OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_AUTO_SHARE: 'false',
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', permission: {
              '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow',
              external_directory: { '*': 'deny', [join(dir, 'output').replaceAll('\\', '/') + '/**']: 'allow' },
            } }) },
        };
      },
    });
  }
}
