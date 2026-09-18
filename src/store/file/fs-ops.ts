// 파일 구현체가 쓰는 파일 시스템 연산. 테스트가 이 계층을 감싸 장애(I/O 오류, 프로세스 종료)를 주입한다.

import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, truncate } from 'node:fs/promises';

export interface FileOps {
  mkdir(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** 재귀 삭제. 없어도 오류가 아니다. */
  remove(path: string): Promise<void>;
  /** 빈 디렉터리만 삭제한다. */
  removeEmptyDir(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  /** 쓰고 fsync 한다. */
  writeFile(path: string, data: string | Buffer): Promise<void>;
  /** 파일 끝에 덧붙이고 fsync 한다. */
  append(path: string, data: Buffer): Promise<void>;
  truncate(path: string, length: number): Promise<void>;
  /** 파일 크기. 없으면 undefined. */
  size(path: string): Promise<number | undefined>;
  /** 디렉터리의 항목 이름. 디렉터리가 없으면 빈 배열. */
  readdir(path: string): Promise<string[]>;
}

export function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

async function writeAndSync(path: string, flags: 'w' | 'a', data: string | Buffer): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const nodeFileOps: FileOps = {
  async mkdir(path, recursive) {
    await mkdir(path, { recursive });
  },
  rename,
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  removeEmptyDir: rmdir,
  readFile: (path) => readFile(path),
  writeFile: (path, data) => writeAndSync(path, 'w', data),
  append: (path, data) => writeAndSync(path, 'a', data),
  truncate,
  async size(path) {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return undefined;
      throw error;
    }
  },
  async readdir(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return [];
      throw error;
    }
  },
};

/** Windows 에서 다른 프로세스(백신, 에디터, reader)가 파일을 열고 있을 때 나는 일시적 오류. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 일시적 오류면 지수 백오프로 다시 시도한다. 총 대기 시간이 budgetMs 를 넘으면 마지막 오류를 던진다. */
export async function retryTransient<T>(budgetMs: number, fn: () => Promise<T>): Promise<T> {
  let waited = 0;
  let delay = 10;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!TRANSIENT.has(codeOf(error) ?? '') || waited >= budgetMs) throw error;
      await sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, 200);
    }
  }
}
