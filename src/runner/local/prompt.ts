import { loadSchemas } from '../../schema/registry.mjs';

// Output protocol only; never assembles Context, Ledger or repository instructions.
export function workerPrompt(prompt: string, outputPath: string): string {
  const schema = loadSchemas().validator('worker-output').schema;
  return `${prompt}\n\n[devflow output contract]\nWrite the role output as UTF-8 JSON to this exact file: ${JSON.stringify(outputPath)}.\nThe parent directory already exists. stdout is only a diagnostic log, never the role output.\nDo not change execution management files. Use the existing Task workspace; do not create another worktree.\nOutput JSON schema:\n${JSON.stringify(schema)}\n`;
}
