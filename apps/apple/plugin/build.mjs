// Bundles the plugin's MCP server into plugins/apple/server: main.mjs, one
// connector folder per built-in Apple app (its connector.json beside its
// entry point), the host modules a user's connector imports, and the chunks
// they all share, so every connector runs on the same elt and AppleApp as the
// server. @nx/esbuild cannot name each entry's output, so this calls
// esbuild's API.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { hostModules } from '@workspace/apple-manifest/host-modules';

const connectors = 'apps/apple/connectors/dist/apps';
const eventkit = 'apps/apple/connectors/dist/platform/macos/eventkit';
const outdir = 'plugins/apple/server';

const builtIns = readdirSync(connectors, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => {
    const folder = join(connectors, name);
    const { entry } = JSON.parse(
      readFileSync(join(folder, 'connector.json'), 'utf8'),
    );
    return {
      folder,
      in: join(folder, entry),
      out: join('connectors', name, basename(entry, extname(entry))),
    };
  });

rmSync(outdir, { recursive: true, force: true });
const { metafile } = await build({
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
  metafile: true,
  logLevel: 'warning',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

for (const { folder, out } of builtIns)
  copyFileSync(
    join(folder, 'connector.json'),
    join(outdir, dirname(out), 'connector.json'),
  );

// The EventKit client finds its helper beside the file it was bundled into.
const client = Object.entries(metafile.outputs).find(([, { inputs }]) =>
  Object.keys(inputs).some((input) =>
    input.endsWith('platform/macos/eventkit.js'),
  ),
);
if (client === undefined)
  throw new Error('No bundled file holds the EventKit client.');
mkdirSync(dirname(client[0]), { recursive: true });
copyFileSync(eventkit, join(dirname(client[0]), 'eventkit'));
