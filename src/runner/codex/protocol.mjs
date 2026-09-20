export const initialInput = text => text;
export const messageInput = () => { throw new Error('Codex CLI does not support live input'); };
export function observe(line) {
  try {
    const e = JSON.parse(line);
    return { ...(e.type === 'thread.started' && typeof e.thread_id === 'string' ? { sessionId: e.thread_id } : {}),
      event: { type: e.type === 'turn.completed' || e.type === 'turn.failed' ? 'end' : e.item?.type === 'command_execution' ? 'tool_call' : 'text', data: e } };
  } catch { return undefined; }
}
