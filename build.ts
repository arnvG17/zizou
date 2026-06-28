import * as esbuild from 'esbuild';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

async function build() {
  console.log('Building Zizou CLI for Node.js...');

  await esbuild.build({
    entryPoints: ['src/cli.tsx'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/cli.js',
    format: 'esm',
    packages: 'external', // Keeps node_modules as external dependencies
    banner: {
      js: '#!/usr/bin/env node\n',
    },
  });

  // Make the output file executable
  const outFile = join(process.cwd(), 'dist/cli.js');
  chmodSync(outFile, 0o755);
  
  console.log('Build complete: dist/cli.js is ready.');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
