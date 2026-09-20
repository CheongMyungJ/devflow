// Detached execution owner. Only confirmed process exit produces a terminal receipt.
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, mkdir, open, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publish, readJson } from './files.mjs';
import { loadSchemas } from '../../schema/registry.mjs';
import { captureCode } from '../../workspace/git/artifact.mjs';
import { readSnapshot } from '../../workspace/git/read-snapshot.mjs';
import { fakeLaunch } from '../fake/launch.mjs';

const dir = process.argv[2];
await mkdir(join(dir, 'supervisor-claim'));
const request = await readJson(dir, 'request.json');
const schemas = loadSchemas();
if (!schemas.validator('runner-local-request')(request)) throw new Error('Invalid local request');
let launch = await readJson(dir, 'launch.json');
if (launch === undefined && request.backend === undefined) launch = fakeLaunch(dir);
if (!schemas.validator('runner-local-launch')(launch)) throw new Error('Invalid local launch');
const protocol = launch.protocolModule ? await import(pathToFileURL(launch.protocolModule).href) : await import('./text-protocol.mjs');
const server = createServer(socket => { socket.setTimeout(1000, () => socket.destroy()); socket.end(request.key.executionId); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
await publish(dir, 'supervisor.json', { pid: process.pid, port: server.address().port, executionId: request.key.executionId });
const files = {};
for (const name of ['stdout.log', 'stderr.log', 'transcript.log', 'normalized.jsonl']) files[name] = await open(join(dir, name), 'wx');
const sizes = {}; const LIMIT = 8 * 1024 * 1024;
let io = Promise.resolve();
function log(name, value) {
  const data = Buffer.from(value), count = Math.min(data.length, Math.max(0, LIMIT - (sizes[name] ?? 0)));
  sizes[name] = (sizes[name] ?? 0) + count;
  if (count) io = io.then(() => files[name].write(data.subarray(0, count))).then(() => undefined);
}
let baseline;
let outcome;
try { if (request.access === 'read') baseline = await readSnapshot(request.workdir, request.readVersion); }
catch { outcome = { state: 'failed', kind: 'read_violation', reason: 'Read baseline cannot be verified; no role process started' }; }
let sessionId, processEndedAt, attempts = 0;
const deadline = request.timeout_seconds ? Date.now() + request.timeout_seconds * 1000 : Infinity;
async function execute(args, attempt) {
  if (await readJson(dir, 'cancel.json')) return { state: 'failed', kind: 'cancelled', reason: 'Cancelled before process launch' };
  const child = spawn(launch.command, args, { cwd: request.workdir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32', env: { ...process.env, ...launch.env, DEVFLOW_EXECUTION_ATTEMPT: String(attempt) } });
  let stopped, finished = false, spawnError, errText = '', pending = '', stopInFlight = false;
  let controls = Promise.resolve();
  const observedMessages = new Set();
  const messagesInFlight = new Set();
  child.stdin.on('error', () => {});
  const started = new Promise((resolve, reject) => {
    child.once('error', error => { spawnError = error; resolve(); });
    child.once('spawn', () => publish(dir, attempt === 1 ? 'process.json' : `process-${attempt}.json`, { pid: child.pid, cwd: request.workdir }).then(resolve, reject));
  });
  child.stdout.on('data', part => {
    log('stdout.log', part); log('transcript.log', part); pending += part.toString('utf8');
    if (pending.length > LIMIT) pending = pending.slice(-LIMIT);
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const observed = protocol.observe(pending.slice(0, i)); pending = pending.slice(i + 1);
      if (observed?.sessionId && /^[A-Za-z0-9_-]{1,128}$/.test(observed.sessionId)) sessionId = observed.sessionId;
      if (observed?.event) log('normalized.jsonl', JSON.stringify(observed.event) + '\n');
      // Claude stream input stays open for intervention until its result event.
      if (observed?.finished && !child.stdin.destroyed) child.stdin.end();
    }
  });
  child.stderr.on('data', part => { log('stderr.log', part); log('transcript.log', part); if (errText.length < LIMIT) errText += part.toString('utf8'); });
  async function stop(kind) {
    if (finished || stopInFlight || !child.pid) return;
    stopInFlight = true; stopped = kind;
    if (process.platform === 'win32') {
      await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    stopInFlight = false;
  }
  async function control() {
    if (finished) return;
    if (await readJson(dir, 'cancel.json')) await stop('cancelled');
    else if (Date.now() >= deadline) await stop('timeout');
    if (!launch.liveInput || finished || child.stdin.destroyed) return;
    for (const name of (await readdir(dir)).filter(n => /^message-[0-9a-f-]{36}\.json$/.test(n)).sort()) {
      if (observedMessages.has(name) || messagesInFlight.has(name)) continue;
      messagesInFlight.add(name);
      const message = await readJson(dir, name);
      // Fence delivery before writing. A crash after the fence is unknown, never re-delivered.
      try { await mkdir(join(dir, `${name}.claim`)); }
      catch (e) { if (e.code !== 'EEXIST') throw e; observedMessages.add(name); continue; }
      observedMessages.add(name);
      const delivered = await new Promise(resolve => {
        if (finished || child.stdin.destroyed) return resolve(false);
        child.stdin.write(protocol.messageInput(message.text, message.id), error => resolve(!error));
      });
      await publish(dir, `message-${message.id}.receipt.json`, { delivered, ...(delivered ? {} : { reason: 'input closed before delivery' }) });
    }
  }
  const timer = setInterval(() => { controls = controls.then(control); controls.catch(() => {}); }, 100);
  const result = await new Promise(resolve => {
    child.once('close', (code, signal) => { finished = true; if (child.pid) processEndedAt = new Date().toISOString(); resolve({ code, signal }); });
    const initial = protocol.initialInput(launch.stdin);
    if (launch.liveInput) child.stdin.write(initial); else child.stdin.end(initial);
  });
  clearInterval(timer); await started; await controls;
  if (spawnError) return { state: 'failed', kind: 'process_exit', reason: 'Role process spawn failed' };
  if (stopped) return { state: 'failed', kind: stopped, reason: stopped === 'timeout' ? 'Execution time limit exceeded; process exit confirmed' : 'Cancellation completed; process exit confirmed' };
  if (result.code !== 0) return { state: 'failed', kind: 'process_exit', reason: `Role exit code=${result.code}, signal=${result.signal}` };
  let output;
  try { output = await readFile(launch.outputPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { state: 'failed', kind: 'invalid_output', reason: 'Role exited successfully without output file' }; }
  try { if (schemas.validator(`${request.role}-output`)(JSON.parse(output))) return { state: 'completed', workerOutput: output }; }
  catch { /* Confirmed malformed output. */ }
  return { state: 'failed', kind: 'invalid_output', reason: `Role output violates ${request.role}-output schema` };
}
while (!outcome) {
  attempts++;
  const result = await execute(launch.args, attempts);
  if (baseline !== undefined) {
    try { if (await readSnapshot(request.workdir, request.readVersion) !== baseline) outcome = { state: 'failed', kind: 'read_violation', reason: 'Read role changed workspace contents, index or HEAD; changes preserved' }; }
    catch { outcome = { state: 'failed', kind: 'read_violation', reason: 'Read postcondition cannot be verified; workspace preserved' }; }
  }
  if (outcome) break;
  if (result.state === 'failed' && result.kind === 'invalid_output' && attempts <= (request.output_retries ?? 0)) {
    try { await rename(launch.outputPath, join(dir, `invalid-output-${attempts}.json`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Original frozen Context remains available; retries get explicit output-only instructions.
    launch.stdin += '\nThe previous role output violated its JSON schema. Preserve completed work and produce the required output file.\n';
    continue;
  }
  outcome = result;
}
if (outcome.state === 'completed' && request.codeArtifact) {
  try { outcome.code = captureCode(request.workdir, request.codeArtifact); }
  catch { outcome = { state: 'failed', kind: 'invalid_output', reason: 'Code artifact requires a clean Task branch HEAD descended from the Workspace base' }; }
}
Object.assign(outcome, { ...(processEndedAt ? { processEndedAt } : {}), sessionPath: 'new', outputAttempts: Math.max(1, attempts), ...(sessionId ? { backendSessionId: sessionId } : {}) });
log('normalized.jsonl', JSON.stringify({ type: 'end', state: outcome.state, at: new Date().toISOString() }) + '\n');
await io;
for (const file of Object.values(files)) await file.close();
if (!schemas.validator('runner-local-result')({ key: request.key, outcome })) throw new Error('Invalid terminal receipt');
await publish(dir, 'result.json', { key: request.key, outcome });
server.close();
