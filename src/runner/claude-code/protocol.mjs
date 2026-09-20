export const initialInput = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
export const messageInput = (text, id) => JSON.stringify({ type: 'user', uuid: id, message: { role: 'user', content: text } }) + '\n';
export function observe(line) {
  try {
    const e = JSON.parse(line);
    return { ...(typeof e.session_id === 'string' ? { sessionId: e.session_id } : {}),
      ...(e.type === 'result' ? { finished: true } : {}),
      event: { type: e.type === 'result' ? 'end' : 'text', data: e } };
  } catch { return undefined; }
}
