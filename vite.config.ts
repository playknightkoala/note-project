import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export default defineConfig({
  plugins: [react(), {
    name: 'notes-offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = ['/', ...Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => `/${name}`)];
      const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16);
      const source = readFileSync(new URL('./src/client/offline/service-worker.js', import.meta.url), 'utf8')
        .replace('__NOTES_SHELL__', `notes-shell-${version}`)
        .replace('/* __NOTES_ASSETS__ */ []', JSON.stringify(assets));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify({ name: 'Notes 筆記', short_name: 'Notes', lang: 'zh-Hant', id: '/', start_url: '/', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: [{ src: '/notes-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }) });
      this.emitFile({ type: 'asset', fileName: 'notes-icon.svg', source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#1769aa"/><path d="M52 148V44h24l40 64V44h24v104h-24L76 84v64z" fill="white"/></svg>' });
    },
  }],
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
