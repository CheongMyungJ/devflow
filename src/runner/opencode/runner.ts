import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionError } from '../types.js';
import { LocalRunner } from '../local/runner.js';
import { cliVersion, resolveCli } from '../local/cli.js';
import { workerPrompt } from '../local/prompt.js';
import type { CliCommand } from '../local/adapter.js';
import type { QuestionRequest } from '../types.js';
import { openOpenCodeQuestion } from './question.js';

export class OpenCodeRunner extends LocalRunner {
  private readonly questionRoot: string;
  private readonly questionCli: CliCommand;
  constructor(root: string, cli: CliCommand = resolveCli('opencode', 'opencode-ai')) {
    super(root, { id: 'opencode', version: cliVersion(cli),
      capabilities: { supportsResume: false, supportsLiveMessage: false },
      validate(request) {
        if (request.model && !/^[^/\s]+\/[^\s]+$/.test(request.model)) throw new ExecutionError('OpenCode model must be provider/model');
        if (request.reasoning) throw new ExecutionError('OpenCode model variants are not verified; reasoning must be omitted');
        if (request.isolation === 'strict') throw new ExecutionError('OpenCode strict isolation is not verified');
      },
      launch(request, dir) {
        const outputPath = join(dir, 'output', 'worker-output.json');
        const args = [...(cli.prefixArgs ?? []), 'run', '--dir', request.workdir, '--format', 'json', '--agent', 'build', ...(request.model ? ['--model', request.model] : [])];
        return { command: cli.command, args,
          stdin: workerPrompt(request.prompt, outputPath, request.role, request.context, request.workdir), outputPath,
          protocolModule: fileURLToPath(new URL('./protocol.mjs', import.meta.url)),
          env: { OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_AUTO_SHARE: 'false',
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', permission: {
              '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow',
              edit: request.access === 'read' ? { '*': 'deny', [outputPath.replaceAll('\\', '/')]: 'allow' } : 'allow',
              external_directory: { '*': 'deny', [join(dir, 'output').replaceAll('\\', '/') + '/**']: 'allow' },
            } }) },
        };
      },
    });
    this.questionRoot = root;
    this.questionCli = cli;
  }
  openQuestion(request: QuestionRequest) { return openOpenCodeQuestion(this.questionRoot, this.questionCli, request); }
}
