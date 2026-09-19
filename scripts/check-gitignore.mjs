// 데이터 repo 의 checkout(보통 repo devflow-data 의 읽기 전용 checkout)의 .gitignore 가 Store 의 내부 파일을 모두 가리는지 본다 (T-0006 AC7).
// 사용: npm run check-gitignore -- <data-dir>
//
// 내부 파일의 이름과 예시 경로는 Store 의 이름 규칙 모듈(src/store/file/names.mjs 의 internalPathExamples)이 내놓는다 — 여기에 사본을 두지 않는다.
// 예시 경로를 `git check-ignore -v --stdin` 에 넣어 모두 무시되는지 본다(경로가 실제로 있지 않아도 git 은 규칙으로 판단한다). 예시의 Task 디렉터리는
// checkout 에 있는 첫 Task 디렉터리(없으면 T-0001)다. 테스트(tests/task-flow.test.ts)는 이 .gitignore 의 사본(tests/fixtures/data-repo-gitignore/)으로
// 내부 파일이 실제로 있는 상태의 git status 를 본다 — 사본과 실제가 어긋나 실제가 내부 파일을 가리지 못하게 되면 이 확인이 실패한다.
// 파일을 쓰지 않는다(git check-ignore 는 읽기만 한다). 빌드 없이 돈다.
// exit code: 0 모두 무시됨, 1 무시되지 않는 것이 있다, 2 사용법 오류이거나 git checkout 이 아니다.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { internalPathExamples, TASK_DIR } from '../src/store/file/names.mjs';

const dataDir = process.argv[2];
if (!dataDir || process.argv.length !== 3) {
  console.error('usage: check-gitignore <data-dir>');
  process.exit(2);
}

const git = (args, input) => execFileSync('git', ['-C', dataDir, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
try {
  if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') throw new Error('not a work tree');
} catch (error) {
  console.error(`${dataDir} 는 git checkout 이 아니다 — .gitignore 를 확인할 수 없다 (${error.message.split('\n')[0]})`);
  process.exit(2);
}

const taskDir = readdirSync(dataDir).filter((name) => TASK_DIR.test(name)).sort()[0] ?? 'T-0001';
const examples = internalPathExamples(taskDir);
let out = '';
try {
  out = git(['check-ignore', '--verbose', '--non-matching', '--stdin'], `${examples.join('\n')}\n`);
} catch (error) {
  // --non-matching 이 있으면 무시되지 않는 경로가 있어도 목록은 나온다. exit 1 은 "하나도 무시되지 않음" 이다.
  if (error.status !== 1) throw error;
  out = error.stdout ?? '';
}

// --verbose --non-matching: 줄마다 "<source>:<line>:<pattern>\t<path>", 무시되지 않으면 "::\t<path>".
const results = out
  .split('\n')
  .filter((line) => line.includes('\t'))
  .map((line) => {
    const [rule, path] = line.split('\t');
    return { path, rule, ignored: rule !== '::' };
  });
let failures = 0;
for (const example of examples) {
  const r = results.find((x) => x.path === example);
  if (r?.ignored) console.log(`ignored  ${example}  (${r.rule})`);
  else {
    failures++;
    console.error(`FAIL not ignored  ${example}`);
  }
}
const head = git(['rev-parse', 'HEAD']).trim();
if (failures) {
  console.error(`${failures} of ${examples.length} internal paths are not ignored at ${head}`);
  process.exit(1);
}
console.log(`ok: all ${examples.length} internal paths are ignored by the .gitignore at ${head}`);
