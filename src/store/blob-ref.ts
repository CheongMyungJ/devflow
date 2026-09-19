// blob key 의 문법 (docs/design/store.md 3.3). 인터페이스의 일부이고 파일 위치는 모른다 — key 를 파일로 옮기는 것은 파일 구현체다.
// 같은 문법이 schemas/artifact.schema.json 의 $defs/blobKey pattern 에 정규식으로 있다. 둘이 같은 key 를 받는지는
// tests/store/blob-key.test.ts 가 같은 key 목록으로 확인한다 — 한쪽을 고치면 다른 쪽도 고친다.

import { InvalidChangeError } from './errors.js';
import type { BlobOwner, BlobRef } from './types.js';

/** <name> 의 확장자. 없으면 Markdown 이다. */
export const BLOB_EXTENSIONS = ['json', 'yaml', 'jsonl', 'diff', 'txt', 'log'] as const;
export type BlobExtension = (typeof BLOB_EXTENSIONS)[number];

const EXT = BLOB_EXTENSIONS.join('|');
/** <label>: 영숫자로 시작하고 영숫자·_·- 만(점 없음). 확장자 이름과 md 는 label 이 될 수 없다. */
const LABEL = `(?!(?:${EXT}|md)(?:\\.|$))[A-Za-z0-9][A-Za-z0-9_-]*`;
const KEY = new RegExp(
  `^blob:(?<taskId>T-[0-9]{4,})/(?:(?<stepId>step-[0-9]{3,})/)?(?<ownerId>(?<owner>[RG])-[0-9]{3,})\\.(?<name>(?<label>${LABEL})(?:\\.(?<ext>${EXT}))?)$`,
);

/** 문법에 맞는 key 를 나눈 것. */
export interface ParsedBlobRef {
  taskId: string;
  /** 없으면 Task 수준(소유자는 Run 만). */
  stepId?: string;
  ownerKind: 'run' | 'gate';
  /** 'R-002', 'G-001' 등. */
  ownerId: string;
  /** <label> 또는 <label>.<ext>. */
  name: string;
  label: string;
  /** 없으면 Markdown. */
  ext?: BlobExtension;
}

/** key 를 나눈다. 문법에 맞지 않으면 undefined — 그런 blob 은 없다. */
export function parseBlobRef(ref: string): ParsedBlobRef | undefined {
  const groups = KEY.exec(ref)?.groups;
  if (!groups) return undefined;
  const ownerKind = groups['owner'] === 'G' ? 'gate' : 'run';
  // Gate 는 언제나 Step 수준이다.
  if (ownerKind === 'gate' && groups['stepId'] === undefined) return undefined;
  return {
    taskId: groups['taskId']!,
    ...(groups['stepId'] !== undefined ? { stepId: groups['stepId'] } : {}),
    ownerKind,
    ownerId: groups['ownerId']!,
    name: groups['name']!,
    label: groups['label']!,
    ...(groups['ext'] !== undefined ? { ext: groups['ext'] as BlobExtension } : {}),
  };
}

/**
 * blob 의 key 를 만든다. 호출자가 commit 전에 key 를 알아 엔티티(content_key, log_key 등)에 담기 위한 순수 함수다.
 * 소유자나 이름이 문법에 맞지 않으면 InvalidChangeError(호출자의 버그).
 */
export function blobRef(owner: BlobOwner, name: string): BlobRef {
  const ownerId = 'gateId' in owner ? owner.gateId : owner.runId;
  const ref = `blob:${owner.taskId}/${owner.stepId !== undefined ? `${owner.stepId}/` : ''}${ownerId}.${name}` as const;
  const parsed = parseBlobRef(ref);
  // 조각에 '/' 나 '.' 이 섞여 다르게 나뉘는 경우도 막는다: 나눈 결과가 준 것과 같아야 한다.
  const same =
    parsed !== undefined &&
    parsed.taskId === owner.taskId &&
    parsed.stepId === owner.stepId &&
    parsed.ownerId === ownerId &&
    parsed.ownerKind === ('gateId' in owner ? 'gate' : 'run') &&
    parsed.name === name;
  if (!same) throw new InvalidChangeError(`not a valid blob key: ${ref}`);
  return ref;
}
