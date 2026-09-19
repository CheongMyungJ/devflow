// 데이터 디렉터리(보통 repo devflow-data 의 읽기 전용 checkout)를 Store 로 열어 모든 Task 의 모든 kind 를 읽어 본다 (T-0005 AC7).
// 사용: npm run check-store-read -- <data-dir>
//
// Task 마다 kind 마다 list 를 불러 invalid 가 비어 있는지, 읽은 항목 수가 그 kind 의 파일 수와 같은지 본다. 기대값은 고정하지 않고
// data-dir 의 파일 이름에서 센다 — 세는 규칙은 Store 와 scripts/validate-data.mjs 가 함께 쓰는 이름 규칙(src/store/file/names.mjs —
// Task 디렉터리 T-<4자리 이상>, steps/ 아래의 디렉터리 가운데 step-<숫자>, D-NNN.yaml, F-NNN.yaml, R-NNN.yaml, G-NNN.yaml, v<N>.meta.yaml,
// steps/<step>/step.yaml)을 여기에 따로 적은 사본이다(그 모듈을 쓰지 않는다 — 같은 규칙을 Store 가 따로 구현해 같은 수를 내는지가
// 확인하려는 것이다. 두 쪽이 같은 판단을 하는지는 tests/store/dir-rules.test.ts 가 본다). 그 밖에:
//  - runs/·gates/ 의 기록이 아닌 파일은 모두 blob 이어야 한다: 파일 이름에서 key 를 만들어 getBlob 으로 읽고 내용이 파일과 같은지 본다.
//  - Run·Feedback 은 get 으로 다시 읽어 list 의 것과 같은지 본다(두 수준을 찾아 보는 get 이 모호하지 않은가).
//  - Artifact meta 의 content_key·work_notes_key 가 getBlob 으로 읽히는지 본다.
// 파일을 쓰지 않는다. Store 의 읽기는 commit 과 겹치지 않으면 lock 을 잡지 않는다(docs/design/store.md 2.7) — 진행 중인 commit 이나
// .pending-* 이 없는 checkout 이면 아무것도 만들지 않는다.
//
// Node 22.15 는 TypeScript 를 import 하지 못하므로 src/ 를 tsc 로 node_modules/.cache/devflow-check-store-read 에 빌드해 쓰고 끝에 지운다
// (tests/global-setup.ts 와 같은 방식이다. node_modules 아래라 git 에 잡히지 않고, 거기서 의존성과 schemas/ 를 찾는다).
// 환경 변수 DEVFLOW_STORE_BUILD 가 있으면 그 디렉터리의 빌드를 쓰고 지우지 않는다(테스트가 이미 만든 빌드).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: check-store-read <data-dir>');
  process.exit(2);
}

function mjsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? mjsFiles(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : [],
  );
}

const given = process.env.DEVFLOW_STORE_BUILD;
const buildDir = given ? resolve(given) : join(REPO_ROOT, 'node_modules', '.cache', 'devflow-check-store-read');
if (!given) {
  rmSync(buildDir, { recursive: true, force: true });
  execSync(`npx tsc -p . --outDir "${buildDir}"`, { cwd: REPO_ROOT, stdio: 'inherit' });
  for (const file of mjsFiles(join(REPO_ROOT, 'src'))) cpSync(file, join(buildDir, relative(REPO_ROOT, file)));
}

let failures = 0;
const fail = (message) => {
  failures++;
  console.error(`FAIL ${message}`);
};

try {
  const { FileStore } = await import(pathToFileURL(join(buildDir, 'src', 'store', 'file', 'index.js')).href);
  const store = new FileStore({ dataDir });

  const entries = (dir) => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : []);
  const named = (dir, re) => entries(dir).filter((f) => re.test(f));
  const RECORD = { decision: /^D-\d+\.yaml$/, feedback: /^F-\d+\.yaml$/, run: /^R-\d+\.yaml$/, gate_result: /^G-\d+\.yaml$/ };
  const META = /^v\d+\.meta\.yaml$/;

  // 디렉터리 이름 규칙의 사본(일부러 — 머리 주석). Store 의 규칙(src/store/file/names.mjs)과 같은 판단을 하는지는 tests/store/dir-rules.test.ts 가 본다.
  const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
  const taskIds = entries(dataDir).filter((d) => /^T-\d{4,}$/.test(d) && isDir(join(dataDir, d)));
  const tasks = await store.list('task', {});
  if (tasks.invalid.length) fail(`task: invalid ${JSON.stringify(tasks.invalid)}`);
  if (tasks.items.length !== taskIds.length) fail(`task: read ${tasks.items.length}, Task directories ${taskIds.length}`);
  console.log(`task: ${tasks.items.length} read / ${taskIds.length} directories, invalid ${tasks.invalid.length}`);

  const totals = {};
  for (const taskId of taskIds) {
    const dir = join(dataDir, taskId);
    const steps = entries(join(dir, 'steps')).filter((s) => /^step-\d+$/.test(s) && isDir(join(dir, 'steps', s)));
    // kind → data-dir 에서 이름 규칙으로 센 파일 수
    const expected = {
      step: steps.filter((s) => existsSync(join(dir, 'steps', s, 'step.yaml'))).length,
      decision: named(join(dir, 'decisions'), RECORD.decision).length,
      feedback: named(join(dir, 'feedback'), RECORD.feedback).length + steps.reduce((n, s) => n + named(join(dir, 'steps', s, 'feedback'), RECORD.feedback).length, 0),
      run: named(join(dir, 'runs'), RECORD.run).length + steps.reduce((n, s) => n + named(join(dir, 'steps', s, 'runs'), RECORD.run).length, 0),
      gate_result: steps.reduce((n, s) => n + named(join(dir, 'steps', s, 'gates'), RECORD.gate_result).length, 0),
      artifact: steps.reduce((n, s) => n + entries(join(dir, 'steps', s, 'artifacts')).reduce((m, a) => m + named(join(dir, 'steps', s, 'artifacts', a), META).length, 0), 0),
    };
    const line = [];
    const read = {};
    for (const [kind, count] of Object.entries(expected)) {
      const result = await store.list(kind, { taskId });
      read[kind] = result.items;
      if (result.invalid.length) fail(`${taskId} ${kind}: invalid ${JSON.stringify(result.invalid)}`);
      if (result.items.length !== count) fail(`${taskId} ${kind}: read ${result.items.length}, files ${count}`);
      line.push(`${kind} ${result.items.length}/${count}`);
      totals[kind] = totals[kind] ?? { read: 0, files: 0, invalid: 0 };
      totals[kind].read += result.items.length;
      totals[kind].files += count;
      totals[kind].invalid += result.invalid.length;
    }

    // Run·Feedback 은 key 에 수준이 없다: get 이 list 와 같은 것을 하나만 찾는가
    for (const kind of ['run', 'feedback']) {
      for (const item of read[kind]) {
        const got = await store.get(kind, { taskId, id: item.id });
        if (!isDeepStrictEqual(got, item)) fail(`${taskId} ${kind} ${item.id}: get differs from list`);
      }
    }

    // runs/·gates/ 의 기록이 아닌 파일은 blob 이다. 파일 이름에서 key 를 만들어 getBlob 으로 읽는다.
    const blobDirs = [
      { rel: 'runs', record: RECORD.run, prefix: '' },
      ...steps.flatMap((s) => [
        { rel: `steps/${s}/runs`, record: RECORD.run, prefix: `${s}/` },
        { rel: `steps/${s}/gates`, record: RECORD.gate_result, prefix: `${s}/` },
      ]),
    ];
    let blobs = 0;
    let blobFiles = 0;
    for (const { rel, record, prefix } of blobDirs) {
      for (const file of entries(join(dir, rel)).filter((f) => !record.test(f))) {
        blobFiles++;
        const key = `blob:${taskId}/${prefix}${file.endsWith('.md') ? file.slice(0, -3) : file}`;
        const content = await store.getBlob(key);
        if (content === undefined) fail(`${taskId}/${rel}/${file}: not readable as ${key}`);
        else if (!Buffer.from(content).equals(readFileSync(join(dir, rel, file)))) fail(`${key}: content differs from the file`);
        else blobs++;
      }
    }
    for (const meta of read.artifact) {
      for (const field of ['content_key', 'work_notes_key']) {
        if (meta[field] !== undefined && (await store.getBlob(meta[field])) === undefined) fail(`${meta.ref} ${field} ${meta[field]}: not readable`);
      }
    }
    line.push(`blob ${blobs}/${blobFiles}`);
    totals.blob = totals.blob ?? { read: 0, files: 0, invalid: 0 };
    totals.blob.read += blobs;
    totals.blob.files += blobFiles;
    console.log(`${taskId}: ${line.join(', ')}`);
  }
  console.log(`total: ${Object.entries(totals).map(([kind, t]) => `${kind} ${t.read}/${t.files} (invalid ${t.invalid})`).join(', ')}`);
} finally {
  if (!given) rmSync(buildDir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'ok: every kind of every Task was read, invalid 0, counts match the files');
process.exit(failures ? 1 : 0);
