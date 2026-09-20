export const initialInput = text => text;
export const messageInput = () => { throw new Error('OpenCode CLI does not support live input'); };
export function observe(line) {
  try { const e = JSON.parse(line); return { ...(typeof e.sessionID === 'string' ? { sessionId: e.sessionID } : {}), event: { type: e.type === 'step_finish' ? 'end' : e.type === 'tool_use' ? 'tool_call' : 'text', data: e } }; }
  catch { return undefined; }
}
