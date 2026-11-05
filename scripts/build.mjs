import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('..', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['src/server.mjs', 'src/cli.mjs'],
  outdir: path.join(root, 'dist'), outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', target: 'node24', format: 'esm',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  sourcemap: false, legalComments: 'eof' });
// Retain licenses for dependencies included in the standalone bundle.
const notices = [];
for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/core', 'zod']) {
  const license = await readFile(path.join(root, 'node_modules', name, 'LICENSE'), 'utf8');
  notices.push(`${name}\n${license}`);
}
await writeFile(path.join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'), 'utf8');
