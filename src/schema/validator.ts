// schemas/*.schema.json 을 컴파일해 런타임 검증에 쓴다 (ADR-0009). 스키마가 엔티티의 기준 정의다.
// 스키마를 읽고 컴파일하는 것은 registry.mjs 하나가 한다(운영 스크립트·테스트와 같은 로더).

import { loadSchemas, type SchemaRegistry } from './registry.mjs';

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

let registry: SchemaRegistry | undefined;

/** 위반 목록을 돌려준다. 비어 있으면 유효하다. */
export function validateAgainst(name: SchemaName, value: unknown): SchemaIssue[] {
  registry ??= loadSchemas();
  const validate = registry.validator(name);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => ({ path: e.instancePath, message: e.message ?? 'invalid' }));
}
