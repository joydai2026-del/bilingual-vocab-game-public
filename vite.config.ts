import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

let buildId = 'dev';
try { buildId = readFileSync('.build-id', 'utf8').trim(); } catch {}

export default defineConfig({
  root: '.',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  build: {
    outDir: 'dist/client',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

