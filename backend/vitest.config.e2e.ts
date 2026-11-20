import { defineConfig } from 'vitest/config';

// End-to-end tests run against a real PostgreSQL database (TEST_DATABASE_URL), migrated once
// in globalSetup. Files run one at a time because they share that database.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
