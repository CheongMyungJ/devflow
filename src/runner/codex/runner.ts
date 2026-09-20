import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionError } from '../types.js';
import { LocalRunner } from '../local/runner.js';
import { cliVersion, resolveCli } from '../local/cli.js';
import { workerPrompt } from '../local/prompt.js';
import type { CliCommand } from '../local/adapter.js';

export class CodexRunner extends LocalRunner {
  constructor(root: string, cli: CliCommand = resolveCli('codex', '@openai/codex')) {
    super(root, { id: 'codex', version: cliVersion(cli),
      capabilities: { supportsResume: false, supportsLiveMessage: false },
      validate(request) {
        if (request.reasoning && (!request.model || !/^(gpt-5|gpt-6|o[134])/.test(request.model) || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(request.reasoning))) throw new ExecutionError('unsupported Codex model/reasoning combination');
        if (request.isolation === 'strict') throw new ExecutionError('strict environment isolation is not verified for Codex; project isolation is available');
      },
      launch(request, dir) {
        const outputPath = join(dir, 'output', 'worker-output.json');
        const config = ['--ignore-user-config', '--ignore-rules', '--config', 'approval_policy="never"',
          ...(process.platform === 'win32' ? ['--config', 'windows.sandbox="elevated"'] : []),
          '--config', 'memories.use_memories=false', '--config', 'memories.generate_memories=false', '--config', 'features.apps=false', '--config', 'project_doc_max_bytes=0',
          ...(request.reasoning ? ['--config', `model_reasoning_effort=${JSON.stringify(request.reasoning)}`] : [])];
        const common = [...config, '--json', ...(request.model ? ['--model', request.model] : [])];
        const permissions = request.access === 'read' ? ['--config', 'default_permissions="devflow_read"',
          '--config', 'permissions.devflow_read.extends=":read-only"', '--config',
          `permissions.devflow_read.filesystem={${JSON.stringify(request.workdir)}="read",${JSON.stringify(join(dir, 'output'))}="write"}`]
          : ['--sandbox', 'workspace-write', '--add-dir', join(dir, 'output')];
        return { command: cli.command, args: [...(cli.prefixArgs ?? []), 'exec', ...permissions,
          ...common, '--cd', request.workdir, '--color', 'never', ...(request.role === 'intake' ? ['--skip-git-repo-check'] : []), '-'],
          stdin: workerPrompt(request.prompt, outputPath, request.role, request.context, request.workdir), env: {}, outputPath,
          protocolModule: fileURLToPath(new URL('./protocol.mjs', import.meta.url)) };
      },
    });
  }
}
