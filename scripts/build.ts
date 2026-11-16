import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({
  entryPoints: ['apps/backend/src/server.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/server.cjs',
  target: 'node22',
});
await viteBuild({ root: 'apps/frontend', configFile: 'apps/frontend/vite.config.ts' });
