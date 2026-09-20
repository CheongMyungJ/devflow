import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2];
const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'));
const fixture = JSON.parse(request.prompt);
// This evidence is deliberately machine-local; it also proves the actual Worker cwd.
await writeFile(join(dir, 'worker.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd() }), { flag: 'wx' });
if (fixture.mode === 'output_then_wait') await writeFile(join(dir, 'output.json'), fixture.output, { flag: 'wx' });
await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
if (fixture.mode === 'fail') process.exit(7);
if (fixture.mode === 'crash') process.kill(process.pid, 'SIGKILL');
if (fixture.mode === 'success') await writeFile(join(dir, 'output.json'), fixture.output, { flag: 'wx' });
