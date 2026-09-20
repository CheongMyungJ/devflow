// 스키마 로더 — schemas/*.schema.json 을 모두 한 ajv 에 등록한 뒤 이름으로 검증 함수를 꺼낸다 (ADR-0009).
//
// 스키마가 파일을 가로질러 $ref 한다(decision 의 next_step.step → step 의 $defs/definition). 그래서 스키마 하나만
// 컴파일하는 로더는 참조를 풀지 못한다. 스키마를 읽는 모든 곳 — src/schema/validator.ts, scripts/validate-data.mjs,
// scripts/record-gate.mjs, tests — 이 이 파일 하나를 쓴다.
//
// 이 파일이 JavaScript(.mjs)인 이유: 운영 스크립트(scripts/*.mjs)는 빌드 없이 node 로 실행되므로 TypeScript 를 import
// 할 수 없다. TypeScript 쪽은 registry.d.mts 의 선언으로 이 파일을 쓴다. tsc 는 이 파일을 출력 디렉터리로 옮기지 않으므로
// src/ 를 tsc 로 빌드해 실행하는 곳(tests/global-setup.ts, scripts/check-store-read.mjs)은 이 파일을 함께 옮긴다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SUFFIX = '.schema.json';

/**
 * fromUrl(보통 import.meta.url)의 디렉터리부터 위로 올라가며 repo 의 schemas/ 를 찾는다.
 * src/ 에서 실행되든, repo 안의 빌드 출력 디렉터리에서 실행되든 같은 schemas/ 를 찾는다.
 */
export function findSchemaDir(fromUrl = import.meta.url) {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    const candidate = join(dir, 'schemas');
    if (existsSync(join(candidate, `task${SUFFIX}`))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('schemas directory not found');
    dir = parent;
  }
}

/**
 * schemaDir 의 *.schema.json 을 모두 등록한 ajv 를 만든다. 검증 함수는 처음 꺼낼 때 컴파일되고 그 뒤로는 같은 것이 돌아온다.
 * 이름은 파일 이름에서 '.schema.json' 을 뗀 것이다('step', 'gate-result' 등).
 */
export function loadSchemas(schemaDir = findSchemaDir()) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  /** @type {Map<string, string>} 이름 → $id */
  const ids = new Map();
  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(SUFFIX)).sort()) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), 'utf8'));
    if (typeof schema.$id !== 'string') throw new Error(`${file}: $id is missing`);
    ajv.addSchema(schema);
    ids.set(file.slice(0, -SUFFIX.length), schema.$id);
  }
  return {
    schemaDir,
    names: [...ids.keys()].sort(),
    validator(name) {
      const id = ids.get(name);
      if (!id) throw new Error(`unknown schema: ${name}`);
      const validate = ajv.getSchema(id);
      if (!validate) throw new Error(`schema ${name} did not compile`);
      return validate;
    },
  };
}
