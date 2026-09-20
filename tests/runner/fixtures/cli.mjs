// Controlled subprocess, not a model integration test. Understands the adapter's actual stdin contract.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const backend = process.argv[2];
const args = process.argv.slice(3);
if (args.includes('--version')) { console.log('9.8.7'); process.exit(0); }
let stdin = '';
for await (const part of process.stdin) stdin += part;
const [raw] = stdin.split('\n\n[devflow output contract]');
const fixture = JSON.parse(raw);
const output = JSON.parse(stdin.match(/exact file: (.+)\./)[1]);
const dir = dirname(dirname(output));
await writeFile(join(dir, 'invocation.json'), JSON.stringify({ backend, args, stdin, cwd: process.cwd(),
  config: process.env.OPENCODE_CONFIG_CONTENT, pid: process.pid }), { flag: 'wx' });
const content = fixture.output ?? JSON.stringify({ summary: 'controlled CLI completed', packet_gaps: [], work_notes: '# notes' });
if (fixture.earlyOutput) await writeFile(output, content, { flag: 'wx' });
if (fixture.commit) {
  await writeFile('created.txt', 'committed by controlled CLI\n', { flag: 'wx' });
  const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
  git('add', 'created.txt'); git('-c', 'core.hooksPath=', 'commit', '-m', 'controlled CLI artifact');
}
await new Promise(resolve => setTimeout(resolve, fixture.delayMs ?? 0));
if (fixture.mode === 'fail') process.exit(7);
if (fixture.mode === 'stdout') { console.log(content); process.exit(0); }
if (fixture.mode !== 'missing' && !fixture.earlyOutput) await writeFile(output, content, { flag: 'wx' });
