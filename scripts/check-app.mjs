// Static checks against a running Notes container (no account, no writes):
//   node scripts/check-app.mjs http://127.0.0.1:8081
// Verifies health, security headers, SPA fallback, API 401/404/CSRF behaviour, cookie flags on a refused login,
// and that nothing from the repository leaks through the static server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:8080').origin;
const fetchText = async (route, init) => { const response = await fetch(origin + route, { redirect: 'manual', ...init }); return { response, text: await response.text() }; };

async function main() {
  const report = { status: 'PASS', origin, checks: [] };
  const check = (name, condition, detail) => { report.checks.push({ name, ok: !!condition, ...(detail ? { detail } : {}) }); assert.ok(condition, name); };

  const health = await fetchText('/healthz');
  check('healthz 200', health.response.status === 200 && health.text.trim() === 'ok');

  const index = await fetchText('/');
  check('index served', index.response.status === 200 && index.text.includes('<div id="root">'));
  check('no inline scripts', !/<script(?![^>]*\bsrc=)[^>]*>[^<]*\S[^<]*<\/script>/i.test(index.text));
  const csp = index.response.headers.get('content-security-policy') ?? '';
  check('CSP script-src self', csp.includes("script-src 'self'") && csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'none'"));
  check('COOP same-origin', index.response.headers.get('cross-origin-opener-policy') === 'same-origin');
  check('nosniff', index.response.headers.get('x-content-type-options') === 'nosniff');
  check('referrer no-referrer', index.response.headers.get('referrer-policy') === 'no-referrer');

  const spa = await fetchText('/p/00000000-0000-0000-0000-000000000000');
  check('SPA fallback', spa.response.status === 200 && spa.text.includes('<div id="root">'));
  check('SPA fallback no-cache', (spa.response.headers.get('cache-control') ?? '').includes('no-cache'));

  const manifest = await fetchText('/manifest.webmanifest');
  check('PWA manifest', manifest.response.status === 200 && JSON.parse(manifest.text).display === 'standalone');
  const worker = await fetchText('/sw.js');
  check('service worker JavaScript', worker.response.status === 200 && (worker.response.headers.get('content-type') ?? '').includes('javascript'));
  check('service worker revalidates', worker.response.headers.get('cache-control') === 'no-cache' && worker.response.headers.get('service-worker-allowed') === '/');
  check('offline asset list built', worker.text.includes('notes-shell-') && worker.text.includes('/assets/') && !worker.text.includes('__NOTES_SHELL__'));
  const icon = await fetchText('/notes-icon.svg');
  check('PWA icon', icon.response.status === 200 && icon.text.startsWith('<svg'));

  for (const route of ['/api/pages/tree', '/api/search?q=x', '/api/auth/me', '/api/admin/users', '/api/trash']) {
    const { response } = await fetchText(route);
    check(`${route} needs login`, response.status === 401);
  }
  const unknown = await fetchText('/api/nothing');
  check('API 404 is JSON', unknown.response.status === 404 && unknown.text.includes('"code":"not_found"'));
  const csrf = await fetchText('/api/pages', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  check('cross-origin POST refused', csrf.response.status === 401 || csrf.response.status === 403);
  const login = await fetchText('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'nobody@example.test', password: 'definitely-wrong-password' }) });
  check('wrong login 401 without cookie', login.response.status === 401 && !login.response.headers.get('set-cookie'));
  check('API responses not cached', (login.response.headers.get('cache-control') ?? '').includes('no-store'));

  for (const route of ['/.env', '/package.json', '/src/server/index.ts', '/.local/dev-accounts.json', '/data/notes.sqlite', '/Dockerfile']) {
    const { response, text } = await fetchText(route);
    check(`${route} not exposed`, response.status === 200 ? text.includes('<div id="root">') : response.status === 404);
  }
  const method = await fetchText('/', { method: 'POST' });
  check('POST to static is refused', method.response.status === 405 || method.response.status === 404);

  const output = path.resolve(__dirname, '../.local/app-static-report.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, origin, checks: report.checks.length }, null, 2));
}

main().catch(error => { console.error(error.message); process.exit(1); });
