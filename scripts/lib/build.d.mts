// build.mjs 의 선언(테스트가 import 한다). 구현과 설명은 build.mjs 에 있다.

export declare const REPO_ROOT: string;
export declare const DEFAULT_CACHE_DIR: string;
export declare const TSC_ARGS: readonly string[];

export declare function loaderFiles(): string[];
export declare function buildKey(options?: { repoRoot?: string; tscArgs?: readonly string[]; loaderText?: string }): string;
export declare function prepareBuild(options?: {
  repoRoot?: string;
  cacheDir?: string;
  tscArgs?: readonly string[];
}): { dir: string; key: string; outcome: 'built' | 'reused' | 'raced' };
