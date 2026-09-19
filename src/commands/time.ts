// 도구가 채우는 시각 (docs/design/commands.md 6절 원칙). 새 command 는 모두 이것으로 시각을 만든다.

import type { Clock } from './context.js';

/**
 * 기록에 넣는 시각: 초 단위 UTC 의 ISO 8601('2026-09-19T11:51:35Z'). 밀리초는 버린다 — 옛 기록과 같은 모양이다(T-0006 F-001 (3)).
 * 한 command 안에서는 한 번 불러 그 값을 모든 이벤트·엔티티에 쓴다.
 */
export function recordedAt(clock: Clock): string {
  const at = clock.now();
  if (Number.isNaN(at.getTime())) throw new RangeError('clock returned an invalid date');
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
