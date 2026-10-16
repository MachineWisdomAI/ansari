import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', '.next'],
    // Issues #292/#290: vitest's defaults (5 s per test, 10 s per hook) are a
    // load-dependent coin flip for CPU-bound work this suite does on purpose —
    // a pglite WASM cold start per file (plus every migration in the parity
    // test), the cold ESLint config load and whole-tree lint, real bcrypt
    // (cost 12). Under a loaded machine those bodies and hooks cross 5 s and
    // whole files go red; on an idle machine they finish in well under 5 s.
    // A hang still fails, just at 30 s instead of 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: [
      { find: '@/lib', replacement: path.resolve(__dirname, './lib') },
      { find: '@/db', replacement: path.resolve(__dirname, './db') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
});
