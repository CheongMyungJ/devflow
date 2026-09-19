// 파일 구현체의 배치 — Task 디렉터리 안에서 기록이 어느 파일에 있는가 (docs/design/store.md 3.1, 3.3).
// 파일 이름 규칙은 여기 한 곳에만 있다: list 가 kind 로 읽는 이름(locOfRel), nextId 가 세는 이름(locOfRel 의 기록과 blob),
// 쓰기가 놓는 자리(relOfLoc), blob key → 파일(blobRelPath)이 모두 이 파일의 함수다. 디렉터리·기록 파일 이름의 정규식은 ./names.mjs 에
// 있다(scripts/validate-data.mjs 가 빌드 없이 같은 것을 import 한다). key 의 문법은 ../blob-ref.ts, ID 와 artifact 참조의 문법은 ../refs.ts 에 있다.
// 위치는 Task 디렉터리 기준이고 구분자는 항상 '/' 다(commit.json 에 그대로 저장된다 — store.md 2.9).

import { type ParsedBlobRef, parseBlobRef } from '../blob-ref.js';
import { idNumber } from '../refs.js';
import type { IssuedIdKind } from '../types.js';
import { META_FILE, RECORD_FILE, STEP_DIR } from './names.mjs';

export { TASK_DIR } from './names.mjs';

/** Task 디렉터리 안의 기록 하나의 자리. kind 는 EntityKind 와 같다. */
export type Loc =
  | { kind: 'task' }
  | { kind: 'step'; stepId: string }
  | { kind: 'decision'; id: string }
  | { kind: 'feedback'; id: string; stepId?: string }
  | { kind: 'run'; id: string; stepId?: string }
  | { kind: 'gate_result'; id: string; stepId: string }
  | { kind: 'artifact'; stepId: string; name: string; version: number };

/** Task 디렉터리 안의 blob 하나의 자리. */
export type BlobLoc = { kind: 'blob'; ref: ParsedBlobRef };

// ---------------------------------------------------------------- 자리 → 파일

export function relOfLoc(loc: Loc): string {
  const under = (stepId: string | undefined) => (stepId !== undefined ? `steps/${stepId}/` : '');
  switch (loc.kind) {
    case 'task':
      return 'task.yaml';
    case 'step':
      return `steps/${loc.stepId}/step.yaml`;
    case 'decision':
      return `decisions/${loc.id}.yaml`;
    case 'feedback':
      return `${under(loc.stepId)}feedback/${loc.id}.yaml`;
    case 'run':
      return `${under(loc.stepId)}runs/${loc.id}.yaml`;
    case 'gate_result':
      return `steps/${loc.stepId}/gates/${loc.id}.yaml`;
    case 'artifact':
      return `steps/${loc.stepId}/artifacts/${loc.name}/v${loc.version}.meta.yaml`;
  }
}

/** blob key → 파일: 소유자가 R- 면 runs/, G- 면 gates/, Step 수준이면 steps/<stepId>/ 아래. <ext> 가 없으면 .md 를 붙인다. */
export function blobRelPath(ref: ParsedBlobRef): string {
  const dir = ref.ownerKind === 'gate' ? 'gates' : 'runs';
  const file = `${ref.ownerId}.${ref.label}.${ref.ext ?? 'md'}`;
  return `${ref.stepId !== undefined ? `steps/${ref.stepId}/` : ''}${dir}/${file}`;
}

// ---------------------------------------------------------------- 파일 → 자리 (list, nextId, get 의 두 수준 찾기가 쓴다)

/**
 * Task 디렉터리 기준 위치를 기록·blob 의 자리로 푼다. 어느 것도 아니면 undefined(Store 가 다루지 않는 파일 — ledger.md 등).
 * runs/ 와 gates/ 에서 이름이 R-NNN.yaml / G-NNN.yaml 인 것만 기록이고, blob 문법으로 풀리는 나머지는 blob 이다.
 */
export function locOfRel(taskId: string, rel: string): Loc | BlobLoc | undefined {
  const parts = rel.split('/');
  if (parts.length === 1 && parts[0] === 'task.yaml') return { kind: 'task' };
  if (parts.length === 2) return recordOrBlob(taskId, undefined, parts[0]!, parts[1]!);
  if (parts[0] !== 'steps' || parts.length < 3 || !STEP_DIR.test(parts[1]!)) return undefined;
  const stepId = parts[1]!;
  if (parts.length === 3) return parts[2] === 'step.yaml' ? { kind: 'step', stepId } : undefined;
  if (parts.length === 4) return recordOrBlob(taskId, stepId, parts[2]!, parts[3]!);
  if (parts.length === 5 && parts[2] === 'artifacts') {
    const meta = META_FILE.exec(parts[4]!);
    if (meta) return { kind: 'artifact', stepId, name: parts[3]!, version: Number(meta[1]) };
  }
  return undefined;
}

function recordOrBlob(taskId: string, stepId: string | undefined, dir: string, file: string): Loc | BlobLoc | undefined {
  const matchId = (kind: keyof typeof RECORD_FILE) => RECORD_FILE[kind].exec(file)?.[1];
  switch (dir) {
    case 'decisions': {
      const id = stepId === undefined ? matchId('decision') : undefined;
      return id !== undefined ? { kind: 'decision', id } : undefined;
    }
    case 'feedback': {
      const id = matchId('feedback');
      return id !== undefined ? { kind: 'feedback', id, ...(stepId !== undefined ? { stepId } : {}) } : undefined;
    }
    case 'runs': {
      const id = matchId('run');
      if (id !== undefined) return { kind: 'run', id, ...(stepId !== undefined ? { stepId } : {}) };
      return blobOfFile(taskId, stepId, 'run', file);
    }
    case 'gates': {
      if (stepId === undefined) return undefined;
      const id = matchId('gate_result');
      if (id !== undefined) return { kind: 'gate_result', id, stepId };
      return blobOfFile(taskId, stepId, 'gate', file);
    }
    default:
      return undefined;
  }
}

/** blobRelPath 의 역. 파일 이름에서 key 를 만들어 보고, 그 key 가 같은 파일로 돌아올 때만 blob 이다. */
function blobOfFile(taskId: string, stepId: string | undefined, ownerKind: 'run' | 'gate', file: string): BlobLoc | undefined {
  const name = file.endsWith('.md') ? file.slice(0, -'.md'.length) : file;
  const ref = parseBlobRef(`blob:${taskId}/${stepId !== undefined ? `${stepId}/` : ''}${name}`);
  if (!ref || ref.ownerKind !== ownerKind) return undefined;
  const dirPrefix = `${stepId !== undefined ? `steps/${stepId}/` : ''}${ownerKind === 'gate' ? 'gates' : 'runs'}/`;
  return blobRelPath(ref) === `${dirPrefix}${file}` ? { kind: 'blob', ref } : undefined;
}

/** nextId 가 세는 번호: 그 자리가 kind 의 ID 를 쓰고 있으면 그 번호. blob 은 소유자의 ID 를 쓰고 있다(store.md 3.4). */
export function issuedNumberOf(taskId: string, rel: string, kind: IssuedIdKind): number | undefined {
  if (kind === 'step') {
    const parts = rel.split('/');
    return parts[0] === 'steps' && parts.length >= 3 && STEP_DIR.test(parts[1]!) ? idNumber('step', parts[1]!) : undefined;
  }
  const loc = locOfRel(taskId, rel);
  if (!loc) return undefined;
  if (loc.kind === 'blob') {
    const ownerKind = kind === 'run' ? 'run' : kind === 'gate_result' ? 'gate' : undefined;
    return loc.ref.ownerKind === ownerKind ? idNumber(kind, loc.ref.ownerId) : undefined;
  }
  return loc.kind === kind && 'id' in loc ? idNumber(kind, loc.id) : undefined;
}

