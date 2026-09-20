// Detached owner: caller termination never closes the Worker or its result channel.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { publish, readJson } from './files.mjs';
import { loadSchemas } from '../../schema/registry.mjs';
import { captureCode } from '../../workspace/git/artifact.mjs';
import { fakeLaunch } from '../fake/launch.mjs';

const dir = process.argv[2];
// A second supervisor can never start a second Worker, even if launched by hand.
await mkdir(join(dir, 'supervisor-claim'));
const request = await readJson(dir, 'request.json');
const schemas = loadSchemas();
if (!schemas.validator('runner-local-request')(request)) throw new Error('Invalid local request');
let launch = await readJson(dir, 'launch.json');
// Compatibility for a prepared fake execution created before ADR-0020.
if (launch === undefined && request.backend === undefined) launch = fakeLaunch(dir);
if (!schemas.validator('runner-local-launch')(launch)) throw new Error('Invalid local launch');
const server = createServer((socket) => {
  socket.setTimeout(1000, () => socket.destroy());
  socket.end(request.key.executionId);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
await publish(dir, 'supervisor.json', { pid: process.pid, port: server.address().port, executionId: request.key.executionId });
const stdout = await open(join(dir, 'stdout.log'), 'wx');
const stderr = await open(join(dir, 'stderr.log'), 'wx');
const child = spawn(launch.command, launch.args, {
  cwd: request.workdir, stdio: ['pipe', stdout.fd, stderr.fd], windowsHide: true,
  env: { ...process.env, ...launch.env },
});
child.stdin.on('error', () => { /* EPIPE is not a result: wait for confirmed process exit. */ });
const started = new Promise((resolve, reject) => {
  child.once('error', resolve);
  child.once('spawn', () => publish(dir, 'process.json', { pid: child.pid, cwd: request.workdir }).then(resolve, reject));
});
const outcome = await new Promise((resolve) => {
  child.once('error', () => resolve({ state: 'failed', kind: 'process_exit', reason: 'Worker spawn failed' }));
  child.once('exit', (code, signal) => resolve(code === 0 ? { state: 'completed' } : {
    state: 'failed', kind: 'process_exit', reason: `Worker exit code=${code}, signal=${signal}`,
  }));
  child.stdin.end(launch.stdin);
});
await started;
await stdout.close(); await stderr.close();
if (outcome.state === 'completed') {
  try { outcome.workerOutput = await readFile(launch.outputPath, 'utf8'); }
  catch (error) {
    // Only a CONFIRMED successful exit plus missing output is a protocol failure.
    if (error.code !== 'ENOENT') throw error;
    Object.assign(outcome, { state: 'failed', kind: 'invalid_output', reason: 'Worker exited successfully without output file' });
  }
}
if (outcome.state === 'completed' && request.codeArtifact) {
  try { outcome.code = captureCode(request.workdir, request.codeArtifact); }
  catch {
    delete outcome.workerOutput;
    Object.assign(outcome, { state: 'failed', kind: 'invalid_output', reason: 'Code artifact requires a clean Task branch HEAD descended from the Workspace base' });
  }
}
await publish(dir, 'result.json', { key: request.key, outcome });
server.close();
