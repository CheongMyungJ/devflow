// command 자신이 던지는 오류. Store 의 오류는 바꾸지 않고 그대로 올린다(docs/design/commands.md 2절) — 이것은 Store 에 가기 전의 거부다.

/**
 * command 가 입력이나 지금 상태에서 그 기록을 받아들이지 않았다(docs/design/commands.md 6.3). 아무것도 기록되지 않았다.
 * 같은 입력으로 다시 불러도 같은 결과다 — 입력을 고치거나 알맞은 command 를 쓴다.
 */
export class RejectedInputError extends Error {
  constructor(
    /** 거부한 까닭. 입력의 위치(`events[0].at` 등)를 앞에 적는다. 하나 이상. */
    readonly reasons: readonly string[],
  ) {
    super(`rejected: ${reasons.join('; ')}`);
    this.name = 'RejectedInputError';
  }
}
