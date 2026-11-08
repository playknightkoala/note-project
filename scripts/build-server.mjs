// Bundles the server into self-contained ESM files so the runtime image needs no node_modules.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: { index: 'src/server/index.ts', cli: 'src/server/cli.ts' },
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  // Node built-ins stay external; everything from node_modules is inlined.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { 'process.env.NOTES_VERSION': JSON.stringify(process.env.npm_package_version ?? '0.0.0') },
};
if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('esbuild watching src/server');
} else {
  await build(options);
}
