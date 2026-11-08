import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Server and shared tests run in node; client tests opt in with `// @vitest-environment jsdom`.
export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    globals: true,
  },
});
