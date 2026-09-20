/** Git branch 이름의 보수적 검사. ref 표현식, 경로, 옵션을 받지 않는다. Git 구현체도 check-ref-format으로 검사한다. */
export function isBranchName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== '@' && !value.startsWith('-') && !value.startsWith('refs/')
    && !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.endsWith('.')
    && value.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
