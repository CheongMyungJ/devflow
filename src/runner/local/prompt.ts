import { loadSchemas } from '../../schema/registry.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Local launch freezes the role instructions and explicit project instructions.
export function workerPrompt(prompt: string, outputPath: string, role = 'worker', context?: string, workdir?: string): string {
  const schemas = loadSchemas();
  const schema = schemas.validator(`${role}-output`).schema;
  const dependencies = new Map<string, unknown>();
  function includeReferences(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const ref = (value as Record<string, unknown>).$ref;
    if (typeof ref === 'string' && !ref.startsWith('#')) {
      const name = ref.split('#')[0]!.split('/').at(-1)!.replace(/\.schema\.json$/, '');
      if (!dependencies.has(name)) {
        const dependency = schemas.validator(name).schema;
        dependencies.set(name, dependency);
        includeReferences(dependency);
      }
    }
    for (const child of Object.values(value)) includeReferences(child);
  }
  includeReferences(schema);
  const roleInstructions = readFileSync(join(schemas.schemaDir, '..', 'roles', `${role}.md`), 'utf8');
  if (context) prompt += `\n[devflow context]\n${context}`;
  if (workdir) {
    try { prompt += `\n[project instructions]\n${readFileSync(join(workdir, 'AGENTS.md'), 'utf8')}\nRead applicable nested project instructions before working in subdirectories.`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (role !== 'worker') prompt += '\nRead-only role: do not change any workspace files, including ignored files. Write only the designated output file.';
  return `${prompt}\n\n[devflow output contract]\nWrite the role output as UTF-8 JSON to this exact file: ${JSON.stringify(outputPath)}.\nThe parent directory already exists. stdout is only a diagnostic log, never the role output.\nDo not change execution management files. Use the existing workspace; do not create another worktree.\nRole instructions:\n${roleInstructions}\nThe managed output protocol requires JSON matching this schema, even if legacy manual examples use YAML:\n${JSON.stringify(schema)}\nReferenced schemas (resolve each $ref against its schema $id):\n${JSON.stringify([...dependencies.values()])}\n`;
}
