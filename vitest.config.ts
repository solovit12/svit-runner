import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // .local holds frozen engine releases (full copies of the repo) and run data; .claude holds agent worktrees.
    exclude: ['vendor/**', 'node_modules/**', 'dist/**', '.local/**', '.claude/**'],
  },
});
