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
/** 이미 내보낸 타입 이름. 다른 스키마의 정의를 $ref 하면 그 정의가 참조하는 파일마다 같은 이름으로 생성된다
 * (StepDefinition 이 step.ts 와 decision.ts 에). index 는 이름마다 처음 나온 파일에서 한 번만 내보낸다. */
const exported = new Set();
for (const file of files) {
  const name = file.replace('.schema.json', '');
  const ts = await compileFromFile(join(schemaDir, file), {
    cwd: schemaDir,
    bannerComment: `/* 생성된 파일. 수정하지 말 것. 원본: schemas/${file} */`,
    additionalProperties: false,
    // minItems 가 있는 배열을 튜플([T, ...T[]])이 아니라 T[] 로 만든다. 빈 배열의 거부는 스키마 검증이 한다 —
    // 튜플이면 실행 중에 조립한 길이를 모르는 배열을 대입할 수 없다.
    ignoreMinAndMaxItems: true,
  });
  await writeFile(join(outDir, `${name}.ts`), ts);
  const names = [...ts.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]).filter((n) => !exported.has(n));
  for (const n of names) exported.add(n);
  if (names.length) exports.push(`export type { ${names.join(', ')} } from './${name}.js';`);
}
await writeFile(join(outDir, 'index.ts'), exports.join('\n') + '\n');
console.log(`generated ${files.length} type files -> src/types/generated`);
