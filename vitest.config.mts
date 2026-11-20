import { defineConfig } from 'vitest/config';

/**
 * Frontend ↔ backend integration tests (`npm run test:live`). They drive the frontend's live data
 * layer — the same functions the screens call — against a running API:
 *   LIVE_API_URL (default http://localhost:4000/api/v1), e.g. `docker compose --profile api up` in backend/.
 * On Windows run it from PowerShell / cmd / the VS Code terminal: a shell that reports the drive in
 * lower case (Git Bash's /e/…) makes Vitest load itself twice and fail with "reading 'config'".
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // *.unit.test.ts: plain unit tests that need no server.
    include: ['src/**/*.live.test.ts', 'src/**/*.unit.test.ts'],
    environment: 'jsdom',
    env: { NEXT_PUBLIC_API_URL: process.env.LIVE_API_URL ?? 'http://localhost:4000/api/v1' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
