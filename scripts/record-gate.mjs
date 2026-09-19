// 0단계 수동 운영용: Reviewer 의 출력 파일(JSON)을 검증한 뒤 Gate 기록(gates/<gate-id>.yaml)으로 옮긴다.
//
// 사용: npm run record-gate -- <data-dir>/<task-id> <step-id> <gate-id> <reviewer-run-id> <artifact-ref>[,<artifact-ref>...] [--annotations <file>]
//
// 읽는 것
//   - steps/<step-id>/runs/<reviewer-run-id>.output.json — Reviewer 의 출력 파일
//   - steps/<step-id>/runs/<reviewer-run-id>.yaml        — 그 Reviewer Run 의 기록(세션을 띄우기 전에 쓰여 있어야 한다)
//   - --annotations <file> (선택)                         — Reviewer 가 아닌 출처(시스템, Worker 의 실측)의 정보.
//       JSON 또는 YAML 파일이고 내용은 [{ source: system|worker, text, ref? }, ...] (gate-result.schema.json 의 annotations).
//       덧붙일 것이 없으면 옵션을 주지 않는다(빈 배열은 거부한다). 위치 인자의 앞·뒤·사이 어디에 두어도 된다.
//       이 파일을 데이터 디렉터리의 steps/<step-id>/runs/ 나 gates/ 아래에 .yaml 로 두면 validate-data 가 Run·Gate 로 읽으려다 실패한다 — 다른 곳에 두거나 .json 으로 둔다.
//
// 쓰기 전에 하는 검증(하나라도 실패하면 오류의 위치와 메시지를 출력하고 exit 1 — Gate 를 쓰지 않고 다른 어떤 파일도 바꾸지 않는다)
//   1. Gate 파일이 아직 없다. Run 기록이 있고 그 id 가 <reviewer-run-id>, role 이 reviewer 다.
//   2. 출력 파일이 schemas/reviewer-output.schema.json 에 맞는다(validate-data 와 같은 로더 — src/schema/registry.mjs 가 schemas/ 를 모두 등록한다).
//      구조화되지 않은(문장) comments, packet_gaps 누락, 정의되지 않은 필드(annotations 포함)는 여기서 거부된다.
//   3. class 가 A 인 지적이 하나라도 있으면 verdict 는 fail 이다(스키마가 강제하지 않는 규칙을 여기서 검사한다).
//   4. 만들어질 Gate 전체(annotations 포함)가 schemas/gate-result.schema.json 에 맞고, YAML 로 썼다가 다시 읽어도 같은 값이다.
//   5. 고쳐질 Run 기록이 schemas/run.schema.json 에 맞고, 다시 읽었을 때 packet_gaps 말고는 모든 필드가 같은 값·같은 타입이다.
//
// 쓰는 것(검증이 모두 끝난 뒤. 순서대로)
//   a. Run 기록의 packet_gaps ← 출력의 packet_gaps (빈 배열도 그대로 옮긴다 — [] = 부족 없음). 기존 내용은 글자 그대로 두고 끝에 덧붙인다.
//      Run 기록에 이미 packet_gaps 가 있으면: 출력의 것과 같을 때만 받아들이고(Run 은 건드리지 않는다) 다르면 거부한다.
//   b. gates/<gate-id>.yaml — verdict, checks, done_when, comments 와 식별 필드(id, task_id, step_id, artifact_refs, reviewer_run_id, created_at),
//      주어졌다면 annotations. packet_gaps 는 Gate 에 넣지 않는다(GateResult 에 그 필드가 없다 — 기록의 기준 자리는 Run 이다).
//   a 와 b 사이에서 죽으면 Run 만 고쳐진 상태가 남는다. 그 상태는 validate-data 를 통과하고, 같은 명령을 다시 실행하면 Gate 가 쓰인다.
//
// exit code: 0 기록함, 1 거부, 2 사용법 오류. 기록 뒤에 validate-data 로 데이터 디렉터리를 검사한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse, parseDocument, stringify } from 'yaml';
import { loadSchemas } from '../src/schema/registry.mjs';

const USAGE = 'usage: record-gate <task-dir> <step-id> <gate-id> <reviewer-run-id> <artifact-ref>[,...] [--annotations <file>]';

function usage(message) {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(2);
}

/** 거부: 이유를 출력하고 exit 1. 이 함수가 불리는 모든 자리는 첫 쓰기보다 앞이다. */
function reject(label, details = []) {
  console.error(`REJECTED ${label}`);
  for (const d of details) console.error(`     ${d}`);
  console.error('nothing was written');
  process.exit(1);
}

// ---- 인자 ----
const positional = [];
let annotationsFile;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--annotations') {
    annotationsFile = argv[++i];
    if (!annotationsFile) usage('--annotations needs a file');
  } else if (arg.startsWith('--annotations=')) {
    annotationsFile = arg.slice('--annotations='.length);
    if (!annotationsFile) usage('--annotations needs a file');
  } else if (arg.startsWith('--')) {
    usage(`unknown option ${arg}`);
  } else {
    positional.push(arg);
  }
}
if (positional.length !== 5 || positional.some((p) => !p)) usage();
const [taskDir, stepId, gateId, runId, refs] = positional;

// ---- 스키마 (validate-data 와 같은 로더 — src/schema/registry.mjs) ----
const { validator } = loadSchemas(join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas'));
function check(schema, value, label) {
  const validate = validator(schema);
  if (validate(value)) return;
  reject(
    `${label} — does not match schemas/${schema}.schema.json`,
    validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`),
  );
}

const stepDir = join(taskDir, 'steps', stepId);
const gateLabel = `steps/${stepId}/gates/${gateId}.yaml`;
const runLabel = `steps/${stepId}/runs/${runId}.yaml`;
const outLabel = `steps/${stepId}/runs/${runId}.output.json`;
const gateFile = join(stepDir, 'gates', `${gateId}.yaml`);
const runFile = join(stepDir, 'runs', `${runId}.yaml`);
const outFile = join(stepDir, 'runs', `${runId}.output.json`);

// ---- 1. 있어야 할 것과 없어야 할 것 ----
if (existsSync(gateFile)) reject(`${gateLabel} already exists`);
if (!existsSync(runFile)) reject(`${runLabel} not found — the Run record is written before the session starts`);
if (!existsSync(outFile)) reject(`${outLabel} not found`);

const runText = readFileSync(runFile, 'utf8');
let run;
try {
  run = parse(runText);
} catch (e) {
  reject(`${runLabel} — not valid YAML`, [e.message]);
}
check('run', run, runLabel);
if (run.id !== runId) reject(`${runLabel} — id is ${run.id}, expected ${runId}`);
if (run.role !== 'reviewer') reject(`${runLabel} — role is ${run.role}, expected reviewer`);

// ---- 2. Reviewer 출력 ----
let out;
try {
  out = JSON.parse(readFileSync(outFile, 'utf8'));
} catch (e) {
  reject(`${outLabel} — not valid JSON`, [e.message]);
}
check('reviewer-output', out, outLabel);

// ---- 3. A 가 있으면 fail ----
const classA = out.comments.flatMap((c, i) => (c.class === 'A' ? [i] : []));
if (classA.length && out.verdict !== 'fail') {
  reject(
    `${outLabel} — verdict is ${out.verdict} but there are class A findings (A 가 하나라도 있으면 verdict 는 fail 이어야 한다)`,
    classA.map((i) => `/comments/${i}/class is A`),
  );
}

// ---- annotations (선택) ----
let annotations;
if (annotationsFile !== undefined) {
  if (!existsSync(annotationsFile)) reject(`--annotations file not found`);
  try {
    annotations = parse(readFileSync(annotationsFile, 'utf8'));
  } catch (e) {
    reject('--annotations file — not valid JSON/YAML', [e.message]);
  }
  if (Array.isArray(annotations) && annotations.length === 0) {
    reject('--annotations file — empty array (덧붙일 것이 없으면 옵션을 주지 않는다)', ['/annotations must NOT have fewer than 1 items']);
  }
}

// ---- 4. 만들어질 Gate ----
const gate = {
  id: gateId,
  task_id: basename(taskDir),
  step_id: stepId,
  artifact_refs: refs.split(','),
  verdict: out.verdict,
  checks: out.checks,
  done_when: out.done_when,
  comments: out.comments,
  ...(annotations !== undefined ? { annotations } : {}),
  reviewer_run_id: runId,
  created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
};
check('gate-result', gate, `${gateLabel} (to be written${annotations !== undefined ? ', annotations from --annotations' : ''})`);
const gateText = stringify(gate, { lineWidth: 0 });
const gateReread = parse(gateText);
if (!isDeepStrictEqual(gateReread, gate)) reject(`${gateLabel} (to be written) — does not survive the YAML round trip`);
check('gate-result', gateReread, `${gateLabel} (to be written, re-read from YAML)`);

// ---- 5. 고쳐질 Run ----
const withoutGaps = (r) => {
  const { packet_gaps: _dropped, ...rest } = r;
  return rest;
};
/** 새 Run 본문이 packet_gaps 만 더하고 다른 필드는 같은 값·같은 타입으로 두는가. */
const keepsEverythingElse = (text) => {
  let reread;
  try {
    reread = parse(text);
  } catch {
    return false;
  }
  return (
    reread !== null &&
    typeof reread === 'object' &&
    isDeepStrictEqual(withoutGaps(reread), withoutGaps(run)) &&
    isDeepStrictEqual(reread.packet_gaps, out.packet_gaps)
  );
};

let newRunText; // undefined 이면 Run 을 건드리지 않는다
if ('packet_gaps' in run) {
  if (!isDeepStrictEqual(run.packet_gaps, out.packet_gaps)) {
    reject(`${runLabel} — already has packet_gaps and it differs from the output's packet_gaps`);
  }
} else {
  // 기존 내용은 글자 그대로 두고 끝에 덧붙인다. 그렇게 쓸 수 없는 모양(예 — 한 줄짜리 flow mapping)이면 문서를 고쳐 쓴다.
  const appended = `${runText}${runText.endsWith('\n') ? '' : '\n'}${stringify({ packet_gaps: out.packet_gaps }, { lineWidth: 0 })}`;
  if (keepsEverythingElse(appended)) {
    newRunText = appended;
  } else {
    const doc = parseDocument(runText);
    doc.set('packet_gaps', out.packet_gaps);
    const rewritten = doc.toString({ lineWidth: 0 });
    if (!keepsEverythingElse(rewritten)) reject(`${runLabel} — cannot add packet_gaps without changing other fields`);
    newRunText = rewritten;
  }
  check('run', parse(newRunText), `${runLabel} (to be rewritten)`);
}

// ---- 쓰기 ----
try {
  mkdirSync(join(stepDir, 'gates'), { recursive: true });
} catch (e) {
  reject(`steps/${stepId}/gates — cannot create the directory`, [e.code ?? e.message]);
}
if (newRunText !== undefined) writeFileSync(runFile, newRunText);
writeFileSync(gateFile, gateText, { flag: 'wx' });
console.log(
  `wrote gates/${gateId}.yaml — verdict ${gate.verdict}, ${gate.checks.length} checks, ${gate.comments.length} comments` +
    (annotations !== undefined ? `, ${annotations.length} annotations` : ''),
);
console.log(
  newRunText !== undefined
    ? `updated runs/${runId}.yaml — packet_gaps (${out.packet_gaps.length})`
    : `runs/${runId}.yaml already had the same packet_gaps (${out.packet_gaps.length}) — left as is`,
);
