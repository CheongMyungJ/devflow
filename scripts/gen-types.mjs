// schemas/*.schema.json -> src/types/generated/*.ts
// 스키마가 엔티티의 기준 정의다 (ADR-0009). 생성물은 commit 하지 않는다.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFromFile } from 'json-schema-to-typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'schemas');
const outDir = join(root, 'src', 'types', 'generated');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const files = (await readdir(schemaDir)).filter((f) => f.endsWith('.schema.json')).sort();
const exports = [];
for (const file of files) {
  const name = file.replace('.schema.json', '');
  const ts = await compileFromFile(join(schemaDir, file), {
    cwd: schemaDir,
    bannerComment: `/* 생성된 파일. 수정하지 말 것. 원본: schemas/${file} */`,
    additionalProperties: false,
  });
  await writeFile(join(outDir, `${name}.ts`), ts);
  exports.push(`export * from './${name}.js';`);
}
await writeFile(join(outDir, 'index.ts'), exports.join('\n') + '\n');
console.log(`generated ${files.length} type files -> src/types/generated`);
