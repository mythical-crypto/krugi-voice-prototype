import { test, expect } from 'bun:test';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('API lifecycle, validation, stale fragments, cancellation and model failures in production Node', async () => {
  const fixture = resolve('runtime/cache/api-fixture.cjs');
  await mkdir(resolve('runtime/cache'), { recursive: true });
  await build({
    entryPoints: ['tests/api-fixture.ts'],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    packages: 'external',
    target: 'node22',
    format: 'cjs',
  });
  const child = spawn(resolve('tools/node/node.exe'), [fixture], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const killTimer = setTimeout(() => child.kill(), 15_000);
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  }).finally(() => clearTimeout(killTimer));
  if (exitCode !== 0) throw new Error(`Node API fixture exited ${exitCode}:\n${output}`);
  expect(output).toContain('API checks passed');
  expect(exitCode).toBe(0);
}, 20_000);
