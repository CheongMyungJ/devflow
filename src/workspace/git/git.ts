import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceError } from '../errors.js';

const exec = promisify(execFile);

/** 옵션은 인자 배열로 전달한다. 비대화형 실행, 유한한 시간, stdout 크기 제한. */
export async function git(cwd: string | undefined, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=', ...args], {
      ...(cwd ? { cwd } : {}), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    });
    return stdout.trim();
  } catch (cause) {
    const detail = cause as { stderr?: string; message?: string };
    throw new WorkspaceError('git', `git ${args[0]} 실패: ${detail.stderr?.trim() || detail.message || '알 수 없는 오류'}`, { cause });
  }
}
