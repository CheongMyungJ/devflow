// commands 가 의존하는 것. 호출하는 쪽(CLI, 서버)이 한 번 만들어 넘긴다. 규약은 docs/design/commands.md.

import type { Store } from '../store/types.js';
import type { BaseBranchResolver } from '../workspace/types.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface CommandContext {
  /** 프로세스당 하나만 만든다 (docs/design/commands.md 5절). */
  store: Store;
  clock: Clock;
  /** 이벤트의 actor. `human:<id>` | `system` | `role:<역할>` */
  actor: string;
  /** 실행 중인 devflow 의 commit SHA. 이벤트에 기록되어 어떤 버전의 프롬프트·스키마로 돌았는지 추적하게 해 준다. */
  systemSha?: string;
  /** Task 입력에 branch가 없을 때 원격 기본 branch를 조회한다. */
  baseBranches?: BaseBranchResolver;
}
