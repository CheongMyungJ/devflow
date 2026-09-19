// 테스트가 띄우는 별도 프로세스. 빌드된 FileStore 를 써서 동시 접근과 프로세스 종료(crash)를 실제로 일으킨다.
// 사용: node child.mjs '<json>'
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = JSON.parse(process.argv[2]);
const { FileStore, nodeFileOps } = await import(pathToFileURL(join(args.build, 'src', 'store', 'file', 'index.js')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);
const event = (note) => ({ type: 'task.requirement_added', actor: 'system', at: '2026-01-01T00:00:00Z', data: { note } });
const sampleTask = (id, title) => ({
  id,
  title,
  type: 'feature',
  goal: 'g',
  acceptance_criteria: [{ id: 'AC1', text: 't' }],
  target: { repo: 'r', base_branch: 'main', task_branch: `task/${id}` },
  status: 'open',
  created_at: '2026-01-01T00:00:00Z',
});

/** 지정한 지점에서 프로세스를 끝낸다. lock 과 .pending 이 남은 채로 죽는 것을 재현한다. */
function crashingOps(at) {
  const die = () => process.exit(9);
  const isEvents = (p) => p.endsWith('events.jsonl');
  return {
    ...nodeFileOps,
    async writeFile(path, data) {
      if (at === 'during-pending' && path.endsWith('commit.json')) die();
      return nodeFileOps.writeFile(path, data);
    },
    async append(path, data) {
      if (at === 'after-pending' && isEvents(path)) die();
      if (at === 'torn-append' && isEvents(path)) {
        // 첫 줄의 중간에서 끊긴다
        await nodeFileOps.append(path, data.subarray(0, Math.floor(data.indexOf(0x0a) / 2)));
        die();
      }
      if (at === 'partial-append' && isEvents(path)) {
        // 여러 이벤트 중 첫 줄만 온전히 기록된다
        await nodeFileOps.append(path, data.subarray(0, data.indexOf(0x0a) + 1));
        die();
      }
      return nodeFileOps.append(path, data);
    },
    async rename(from, to) {
      if (at === 'after-append' && from.endsWith('.tmp')) die();
      return nodeFileOps.rename(from, to);
    },
  };
}

/** append 직전에 멈춰 lock 을 쥔 채 살아 있는 프로세스를 재현한다. */
function holdingOps(holdMs) {
  return {
    ...nodeFileOps,
    async append(path, data) {
      if (path.endsWith('events.jsonl')) {
        say('holding');
        await sleep(holdMs);
      }
      return nodeFileOps.append(path, data);
    },
  };
}

const ops = args.crashAt ? crashingOps(args.crashAt) : args.holdMs ? holdingOps(args.holdMs) : nodeFileOps;
const store = new FileStore({ dataDir: args.dataDir, ops, lockTimeoutMs: 30_000 });

// 모든 자식이 준비된 뒤 한꺼번에 출발한다.
say('ready');
if (args.barrier) while (!existsSync(args.barrier)) await sleep(1);

if (args.action === 'commit') {
  for (let i = 0; i < args.count; i++) await store.commit(args.taskId, { events: [event(`${args.label}-${i}`)] });
} else if (args.action === 'create') {
  const ids = [];
  for (let i = 0; i < args.count; i++) {
    const made = await store.createTask((id) => ({ task: sampleTask(id, `${args.label}-${i}`), events: [{ type: 'task.created', actor: 'system', at: '2026-01-01T00:00:00Z' }] }));
    ids.push(made.task.id);
  }
  say(`ids ${JSON.stringify(ids)}`);
} else if (args.action === 'issue') {
  // Task 안의 ID 발급(store.md 3.4): commit 마다 Run·Gate·Feedback 의 ID 와 Artifact 버전을 발급받아 그 ID 로 기록을 쓴다.
  // Run 은 Task 수준과 Step 수준을 번갈아 쓴다(두 수준이 번호를 나눠 쓴다). 발급받은 것을 한 줄씩 낸다.
  const t = args.taskId;
  for (let i = 0; i < args.count; i++) {
    await store.commit(t, (ctx) => {
      const runId = ctx.nextId('run');
      const gateId = ctx.nextId('gate_result');
      const feedbackId = ctx.nextId('feedback');
      const version = ctx.nextArtifactVersion('step-001', 'change');
      const ref = `artifact://${t}/step-001/change@v${version}`;
      const at = '2026-01-01T00:00:00Z';
      return {
        writes: [
          { kind: 'run', value: { id: runId, task_id: t, ...(i % 2 ? { step_id: 'step-001' } : {}), role: 'worker', access: 'write', backend: 'fake', session_path: 'new', status: 'completed', submitted_at: at } },
          {
            kind: 'artifact',
            value: { ref, task_id: t, step_id: 'step-001', name: 'change', version, type: 'code_change', author: 'worker', run_id: runId, stored_in: 'repo', code: { repo: 'r', branch: 'b', base_sha: 'a', head_sha: 'b' }, paths: ['x'], created_at: at },
          },
          { kind: 'gate_result', value: { id: gateId, task_id: t, step_id: 'step-001', artifact_refs: [ref], verdict: 'pass', checks: [], created_at: at } },
          { kind: 'feedback', value: { id: feedbackId, task_id: t, step_id: 'step-001', kind: 'approval', channel: 'review', target: { artifact_ref: ref }, text: args.label, author: 'x', created_at: at } },
        ],
        blobs: [{ owner: { taskId: t, stepId: 'step-001', gateId }, name: 'deterministic', content: args.label }],
        events: [event(`${args.label}-${i}`)],
      };
    });
  }
} else if (args.action === 'update') {
  // 엔티티 쓰기 + 이벤트 2개. crashAt 과 함께 쓰여 commit 의 각 단계에서 죽는다.
  const task = await store.get('task', { taskId: args.taskId });
  await store.commit(args.taskId, { writes: [{ kind: 'task', value: { ...task, title: args.title } }], events: [event('update-1'), event('update-2')] });
}
say('done');
