import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    setupFiles: ['src/tests/setup.ts'],
    include: ['src/tests/**/*.test.ts'],
    globals: false,
    sequence: { concurrent: false },
  },
});
