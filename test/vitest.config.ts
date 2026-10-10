import { defineConfig } from 'vitest/config';

/** The Bridge's tests. Run from this folder: `npm ci && npm test`. The tests
 *  against a real PostgreSQL server skip themselves unless MAPLITH_PG_TEST_URL
 *  names a throwaway server's superuser (the CI workflow sets it). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    testTimeout: 30_000,
  },
});
