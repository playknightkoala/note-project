import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
    // No inline scripts: the CSP is `script-src 'self'`.
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080', '/healthz': 'http://127.0.0.1:8080' },
  },
});
