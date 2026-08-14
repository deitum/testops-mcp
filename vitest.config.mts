import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      // Every test talks to an HTTP fixture on 127.0.0.1, and axios honours
      // HTTP_PROXY — on a machine that has one set, the fixtures would be
      // routed through it and answer with the proxy's error instead.
      NO_PROXY: '127.0.0.1,localhost',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/index.ts'],
      // A floor, not a target: set a little below what the suite currently
      // achieves, so that a drop is noticed but small refactors aren't blocked.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
