// schemas/*.schema.json 을 컴파일해 런타임 검증에 쓴다 (ADR-0009). 스키마가 엔티티의 기준 정의다.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export type SchemaName =
  | 'task'
  | 'step'
  | 'artifact'
  | 'feedback'
  | 'gate-result'
  | 'decision'
  | 'event'
  | 'run'
  | 'project-config';

export interface SchemaIssue {
  /** 위반 위치 (JSON Pointer). 루트면 빈 문자열. */
  path: string;
  message: string;
}

/** 이 파일이 src/ 에 있든 빌드 출력 디렉터리에 있든 repo 의 schemas/ 를 찾는다. */
function findSchemaDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'schemas');
    if (existsSync(join(candidate, 'task.schema.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('schemas directory not found');
    dir = parent;
  }
}

let ajv: Ajv2020 | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

function validatorFor(name: SchemaName): ValidateFunction {
  let validate = compiled.get(name);
  if (!validate) {
    if (!ajv) {
      ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats.default(ajv);
    }
    validate = ajv.compile(JSON.parse(readFileSync(join(findSchemaDir(), `${name}.schema.json`), 'utf8')));
    compiled.set(name, validate);
  }
  return validate;
}

/** 위반 목록을 돌려준다. 비어 있으면 유효하다. */
export function validateAgainst(name: SchemaName, value: unknown): SchemaIssue[] {
  const validate = validatorFor(name);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => ({ path: e.instancePath, message: e.message ?? 'invalid' }));
}
