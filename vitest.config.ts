import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit-test config for pure frontend logic (sanitizers, render helpers). Kept
// separate from the Astro build — `astro build` does not read this file.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
