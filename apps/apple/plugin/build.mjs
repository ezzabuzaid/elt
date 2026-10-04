// Bundles the plugin's MCP server into plugins/apple/server: main.mjs, one
// connector folder per built-in Apple app (its package.json manifest beside
// its entry point), the host modules a user's connector imports, and the chunks
// they all share, so every connector runs on the same elt and AppleApp as the
// server. @nx/esbuild cannot name each entry's output, so this calls
// esbuild's API.
import { copyFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { ConnectorManifest } from '@workspace/connector-apple-manifest/connector-manifest';
import { hostModules } from '@workspace/connector-apple-manifest/host-modules';

const eventkitHelper = 'packages/macos/eventkit/dist/eventkit-helper';
const outdir = 'plugins/apple/server';

const builtIns = readdirSync(builtInConnectors)
  .map((name) => ConnectorManifest.read(join(builtInConnectors, name)))
  .filter((manifest) => manifest !== undefined)
  .map((manifest) => ({
    manifest,
    in: manifest.entry,
    out: join(
      'connectors',
      manifest.name,
      basename(manifest.entry, extname(manifest.entry)),
    ),
  }));

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: [
    { in: 'apps/apple/plugin/src/main.ts', out: 'main' },
    ...builtIns.map(({ in: source, out }) => ({ in: source, out })),
    ...hostModules.map(({ specifier, file }) => ({
      in: fileURLToPath(import.meta.resolve(specifier)),
      out: join('modules', file),
    })),
  ],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24.19',
  outExtension: { '.js': '.mjs' },
  chunkNames: 'chunks/[name]-[hash]',
  tsconfig: 'apps/apple/plugin/tsconfig.json',
  logLevel: 'warning',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

for (const { manifest, out } of builtIns)
  writeFileSync(
    join(outdir, 'connectors', manifest.name, 'package.json'),
    JSON.stringify({
      type: 'module',
      exports: `./${basename(out)}.mjs`,
      contextCompiler: { name: manifest.name, title: manifest.title },
    }),
  );

// main.ts hands this path to the Calendar and Reminders apps.
copyFileSync(eventkitHelper, join(outdir, 'eventkit-helper'));
