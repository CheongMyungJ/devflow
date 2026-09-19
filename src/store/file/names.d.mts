// names.mjs 의 선언. 규칙과 설명은 names.mjs 에 있다.

export declare const TASK_DIR: RegExp;
export declare const STEP_DIR: RegExp;
export declare const RECORD_FILE: Readonly<Record<'decision' | 'feedback' | 'run' | 'gate_result', RegExp>>;
export declare const META_FILE: RegExp;
export declare const LOCKS_DIR: string;
export declare const PENDING_PREFIX: string;
export declare const ROLLBACKS_FILE: string;
export declare function internalPathExamples(taskDir: string): string[];
export declare function isInternalPath(rel: string): boolean;
