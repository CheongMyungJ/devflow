// 데이터 repo 의 checkout(보통 repo devflow-data 의 읽기 전용 checkout)의 .gitignore 가 Store 의 내부 파일을 모두 가리는지 본다 (T-0006 AC7).
// 사용: npm run check-gitignore -- <data-dir>
//
// 내부 파일의 이름과 예시 경로는 Store 의 이름 규칙 모듈(src/store/file/names.mjs 의 internalPathExamples)이 내놓는다 — 여기에 사본을 두지 않는다.
// 예시 경로를 `git check-ignore -z --verbose --non-matching --stdin` 에 넣고(경로가 실제로 있지 않아도 git 은 규칙으로 판단한다), 경로마다 git 이
// 알려 준 마지막으로 맞은 규칙이 다음을 모두 만족해야 "무시됨" 으로 본다:
//   - 부정 규칙(!pattern)이 아니다 — 부정 규칙이 마지막으로 맞으면 git 은 그 경로를 무시하지 않는다(git status 에 보인다).
//   - 규칙의 출처가 이 checkout 이 추적하는 .gitignore 파일이고 HEAD 와 내용이 같다 — core.excludesFile(사용자 설정)이나 .git/info/exclude,
//     추적하지 않거나 고친 .gitignore 의 규칙은 데이터 repo 가 보장하는 것이 아니므로 받지 않는다. git 은 이 셋보다 .gitignore 를 앞세워
//     알려 주므로, 추적하는 .gitignore 에 규칙이 있으면 다른 출처의 규칙에 가려지지 않는다.
// 예시의 Task 디렉터리는 checkout 에 있는 첫 Task 디렉터리(없으면 T-0001)다. 테스트(tests/task-flow.test.ts)는 이 .gitignore 의 사본
// (tests/fixtures/data-repo-gitignore/)으로 내부 파일이 실제로 있는 상태의 git status 를 본다 — 사본과 실제가 어긋나 실제가 내부 파일을 가리지
// 못하게 되면 이 확인이 실패한다.
// 파일을 쓰지 않는다(git check-ignore·ls-files·diff 는 읽기만 한다). 빌드 없이 돈다.
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
  out = git(['check-ignore', '-z', '--verbose', '--non-matching', '--stdin'], examples.map((p) => `${p}\0`).join(''));
} catch (error) {
  // --non-matching 이 있으면 무시되지 않는 경로가 있어도 목록은 나온다. exit 1 은 "하나도 무시되지 않음" 이다.
  if (error.status !== 1) throw error;
  out = error.stdout ?? '';
}

// -z --verbose --non-matching: 경로마다 NUL 로 끝나는 네 칸 <source> <line> <pattern> <path>. 맞은 규칙이 없으면 앞 세 칸이 비었다.
const fields = out.split('\0');
const results = new Map();
for (let i = 0; i + 3 < fields.length; i += 4) {
  const [source, line, pattern, path] = fields.slice(i, i + 4);
  results.set(path, source === '' ? undefined : { source, pattern, rule: `${source}:${line}:${pattern}` });
}

/** 규칙의 출처가 이 checkout 이 추적하는 .gitignore 이고 HEAD 와 내용이 같은가. 아니면 그 까닭. */
const sourceProblem = new Map();
function repoSourceProblem(source) {
  if (sourceProblem.has(source)) return sourceProblem.get(source);
  let problem;
  if (source.split('/').at(-1) !== '.gitignore') problem = 'not a .gitignore file (core.excludesFile or .git/info/exclude)';
  else {
    let tracked = '';
    try {
      tracked = git(['--literal-pathspecs', 'ls-files', '-z', '--', source]);
    } catch {
      tracked = ''; // checkout 밖의 경로
    }
    if (tracked !== `${source}\0`) problem = 'not a tracked .gitignore of the checkout';
    else {
      try {
        git(['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', source]);
      } catch (error) {
        if (error.status !== 1) throw error;
        problem = 'differs from HEAD';
      }
    }
  }
  sourceProblem.set(source, problem);
  return problem;
}

let failures = 0;
for (const example of examples) {
  const r = results.get(example);
  let problem;
  if (!r) problem = 'no rule';
  else if (r.pattern.startsWith('!')) problem = `negated by ${r.rule}`;
  else {
    const why = repoSourceProblem(r.source);
    if (why) problem = `${r.rule} — ${why}`;
  }
  if (!problem) console.log(`ignored  ${example}  (${r.rule})`);
  else {
    failures++;
    console.error(`FAIL not ignored  ${example}  (${problem})`);
  }
}
let head = '(no commit)';
try {
  head = git(['rev-parse', '--verify', 'HEAD']).trim();
} catch {
  // commit 이 없는 checkout — 추적하는 .gitignore 도 없으므로 위에서 이미 모두 실패했다
}
if (failures) {
  console.error(`${failures} of ${examples.length} internal paths are not ignored by the tracked .gitignore at ${head}`);
  process.exit(1);
}
console.log(`ok: all ${examples.length} internal paths are ignored by the tracked .gitignore at ${head}`);
