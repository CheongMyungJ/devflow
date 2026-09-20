import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 60_000,
    // Bound Windows concurrency to leave room for the detached supervisors and Git
    // subprocesses used by these fixtures to finish their startup handshakes.
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {}),
  },
});
