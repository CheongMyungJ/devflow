// registry.mjs 의 선언. 구현과 설명은 registry.mjs 에 있다.
import type { ValidateFunction } from 'ajv/dist/2020.js';

export interface SchemaRegistry {
  /** 스키마를 읽은 디렉터리. */
  readonly schemaDir: string;
  /** 등록한 스키마의 이름('step', 'gate-result' 등). 파일 이름 순. */
  readonly names: string[];
  /** 이름의 검증 함수. 처음 부를 때 컴파일된다. 없는 이름이면 예외. */
  validator(name: string): ValidateFunction;
}

export declare function findSchemaDir(fromUrl?: string): string;
export declare function loadSchemas(schemaDir?: string): SchemaRegistry;
