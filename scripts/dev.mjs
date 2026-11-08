// Development: esbuild watches the server, node --watch restarts it, vite serves the client with /api proxied.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const env = { ...process.env, DATA_DIR: process.env.DATA_DIR ?? 'data', PORT: process.env.PORT ?? '8080', NODE_ENV: 'development' };
const run = (command, args) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', env });
  child.on('exit', code => { if (code && code !== 0) process.exitCode = code; });
  return child;
};
const children = [
  run('node', ['scripts/build-server.mjs', '--watch']),
  run('node', ['--watch', '--watch-preserve-output', '--disable-warning=ExperimentalWarning', 'dist/server/index.js']),
  run('npx', ['vite']),
];
const stop = () => { for (const child of children) child.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
