#!/usr/bin/env node
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  minify: false,
  banner: {
    js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
  },
};

async function main() {
  await Promise.all([
    build({
      ...shared,
      entryPoints: [path.join(root, 'src/mcp/server.ts')],
      outfile: path.join(root, 'dist/bundle/server.mjs'),
    }),
    build({
      ...shared,
      entryPoints: [path.join(root, 'src/hooks/post-invocation.ts')],
      outfile: path.join(root, 'dist/bundle/post-invocation.mjs'),
    }),
    build({
      ...shared,
      entryPoints: [path.join(root, 'src/cli/index.ts')],
      outfile: path.join(root, 'dist/bundle/cli.mjs'),
    }),
    build({
      ...shared,
      external: ['sidecar_sdk'],
      entryPoints: [path.join(root, 'src/sidecar/main.ts')],
      outfile: path.join(root, 'dist/bundle/sidecar.mjs'),
    }),
  ]);
  console.log('✓ Built standalone zero-dependency bundles in dist/bundle/');
}

main().catch((err) => {
  console.error('Bundle build failed:', err);
  process.exit(1);
});
