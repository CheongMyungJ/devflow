// 입구(scripts/*.mjs)가 함께 쓰는 것: 인자 해석, 입력 파일 읽기, 결과와 거부의 보고 (docs/design/commands.md 6.1·6.3).
// 데이터 디렉터리에 쓰지 않고 Store 를 모른다 — 기록은 입구가 조립 지점(./assemble.mjs)에서 받은 commands.* 만 쓴다.
// 읽는 파일(패킷, 역할 세션의 출력, 사람이 쓴 정의)의 로컬 경로는 여기서 내용으로 바뀌고 command 에는 가지 않는다.
// exit code: 0 성공, 1 거부/실패, 2 사용법 오류. WorkspacePreparationError는 기록/Git 결과가 남을 수 있다.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** 사용법을 보이고 exit 2. */
export function usageExit(usage, message) {
  console.error(message ? `${message}\n${usage}` : usage);
  process.exit(2);
}

/**
 * 인자를 나눈다. spec:
 *   usage: 사용법 문장
 *   positional: 위치 인자의 이름(앞 둘은 data-dir, task-id — issue-task 만 data-dir 과 정의 파일)
 *   oldShape: 옛 입구의 위치 인자 수(<task-dir> 로 시작하던 모양) — 그 수로 부르면 사용법 오류
 *   options: { 이름: { value?: true, repeat?: true, required?: true } } — value 가 없으면 값 없는 깃발
 *   human: true 면 --actor human:<id> 필수(사람이 한 일의 입구). false 면 --actor 를 받지 않는다(시스템·역할 세션의 기록)
 * --<이름>=<값> 도 받는다. 모르는 옵션(예: 시각을 주려는 --at)은 사용법 오류다 — 시각은 도구가 채운다.
 * @returns {{ args: Record<string,string>, opts: Record<string, any>, actor: string }}
 */
export function parseEntryArgs(argv, spec) {
  const options = { ...(spec.options ?? {}), ...(spec.human ? { actor: { value: true, required: true } } : {}) };
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      pos.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const o = options[name];
    if (o === undefined) usageExit(spec.usage, `모르는 옵션 --${name}`);
    if (!o.value) {
      opts[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') usageExit(spec.usage, `--${name} 에 값이 없다`);
    if (o.repeat) (opts[name] ??= []).push(value);
    else if (name in opts) usageExit(spec.usage, `--${name} 가 두 번 있다`);
    else opts[name] = value;
  }
  if (spec.oldShape !== undefined && pos.length === spec.oldShape) {
    usageExit(spec.usage, '옛 인자 모양(<task-dir> …)은 받지 않는다 — <data-dir> <task-id> … 로 준다');
  }
  if (pos.length !== spec.positional.length || pos.some((p) => p === '')) usageExit(spec.usage);
  for (const [name, o] of Object.entries(options)) if (o.required && opts[name] === undefined) usageExit(spec.usage, `--${name} 가 필요하다`);
  if (spec.human && !/^human:\S/.test(opts.actor)) usageExit(spec.usage, '--actor 는 human:<id> 모양이다');
  return { args: Object.fromEntries(spec.positional.map((n, i) => [n, pos[i]])), opts, actor: opts.actor ?? 'system' };
}

/** <task-id> 의 모양 — 판단은 command 쪽의 isTaskId(src/store/refs.ts) 하나다. 입구에 사본을 두지 않는다. */
export function checkTaskId(commands, taskId, usage) {
  if (!commands.isTaskId(taskId)) usageExit(usage, `<task-id> 가 T-NNNN 모양이 아니다: ${taskId}`);
}

/** 양의 정수 옵션. */
export function intOption(value, name, usage) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) usageExit(usage, `--${name} 는 1 이상의 정수다`);
  return Number(value);
}

/** 파일의 내용(UTF-8). 못 읽으면 exit 1 — 아직 아무것도 쓰지 않았다. 경로는 문구에만 쓰고 command 에 넘기지 않는다. */
export function readText(file, label) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`${label} 을 읽지 못했다: ${error.code ?? error.message} — 아무것도 기록하지 않았다`);
    process.exit(1);
  }
}

/** YAML(또는 JSON) 파일의 원문과 값. */
export function readStructured(file, label) {
  const text = readText(file, label);
  try {
    return { text, value: parseYaml(text) };
  } catch (error) {
    console.error(`${label} 이 YAML/JSON 이 아니다: ${error.message} — 아무것도 기록하지 않았다`);
    process.exit(1);
  }
}

/** commit 결과를 한 줄로. */
export function committed(result) {
  const seqs = result.events.map((e) => e.seq);
  return `seq ${seqs[0]}..${seqs.at(-1)}, commit ${result.commitId}`;
}

/** 사람의 말: --text <문장> 또는 --text-file <파일> 가운데 하나(여러 줄이면 파일). */
export const TEXT_OPTIONS = { text: { value: true }, 'text-file': { value: true } };
export function textFrom(opts, usage) {
  if ((opts.text === undefined) === (opts['text-file'] === undefined)) usageExit(usage, '--text 와 --text-file 가운데 하나를 준다');
  return opts.text ?? readText(opts['text-file'], '--text-file');
}

/** command 를 부르고 결과나 거부를 보인다. 거부·Store 오류는 exit 1. */
export async function report(work) {
  try {
    const lines = await work();
    for (const line of [].concat(lines)) console.log(line);
  } catch (error) {
    if (error?.name === 'WorkspacePreparationError') {
      console.error(`${error.name}: ${error.message}`);
    } else if (error?.name === 'RejectedInputError') {
      console.error('rejected — 아무것도 기록하지 않았다:');
      for (const reason of error.reasons) console.error(`  ${reason}`);
    } else if (error?.name === 'CommitOutcomeUnknownError') {
      console.error(`${error.message} — 기록되었는지 확인하지 못했다. events.jsonl 에서 commit ${error.commitId} 를 찾아 확인하라`);
    } else {
      console.error(`${error?.name ?? 'Error'}: ${error?.message ?? error} — 아무것도 기록하지 않았다`);
      for (const issue of error?.issues ?? []) console.error(`  ${issue.path || '/'} ${issue.message}`);
    }
    process.exit(1);
  }
}
