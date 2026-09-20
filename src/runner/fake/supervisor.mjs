// Detached owner: caller termination never closes the Worker or its result channel.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish, readJson } from './files.mjs';

const dir = process.argv[2];
// A second supervisor can never start a second Worker, even if launched by hand.
await mkdir(join(dir, 'supervisor-claim'));
const request = await readJson(dir, 'request.json');
const server = createServer((socket) => {
  socket.setTimeout(1000, () => socket.destroy());
  socket.end(request.key.executionId);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
await publish(dir, 'supervisor.json', { pid: process.pid, port: server.address().port, executionId: request.key.executionId });
const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), dir], {
  cwd: request.workdir, stdio: 'ignore', windowsHide: true,
});
const outcome = await new Promise((resolve) => {
  child.once('error', () => resolve({ state: 'failed', kind: 'process_exit', reason: 'Worker spawn failed' }));
  child.once('exit', (code, signal) => resolve(code === 0 ? { state: 'completed' } : {
    state: 'failed', kind: 'process_exit', reason: `Worker exit code=${code}, signal=${signal}`,
  }));
});
if (outcome.state === 'completed') {
  try { outcome.workerOutput = await readFile(join(dir, 'output.json'), 'utf8'); }
  catch (error) {
    // Only a CONFIRMED successful exit plus missing output is a protocol failure.
    if (error.code !== 'ENOENT') throw error;
    Object.assign(outcome, { state: 'failed', kind: 'invalid_output', reason: 'Worker exited successfully without output file' });
  }
}
await publish(dir, 'result.json', { key: request.key, outcome });
server.close();
