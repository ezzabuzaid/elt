// Bundles the plugin's MCP server into plugins/apple/server: main.mjs, one
// folder per built-in connector (its package.json manifest beside its entry
// point and its presets), the host modules a user's connector imports, and
// the chunks they all share, so every connector runs on the same elt and
// AppleConnector as the server.
// It also builds the sidebar page into one self-contained page.html, since the
// page's sandbox loads nothing from the network.
// @nx/esbuild cannot name each entry's output, so this calls esbuild's API.
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { peopleFile } from '@workspace/apple-people/people';
import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { ConnectorManifest } from '@workspace/connector-apple-manifest/connector-manifest';
import { hostModules } from '@workspace/connector-apple-manifest/host-modules';

const eventkitHelper = 'packages/sdks/apple/eventkit/dist/eventkit-helper';
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

for (const { manifest, out } of builtIns) {
  const folder = join(outdir, 'connectors', manifest.name);
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({
      type: 'module',
      exports: `./${basename(out)}.mjs`,
      contextCompiler: { name: manifest.name, title: manifest.title },
    }),
  );
  const presets = join(manifest.folder, 'presets');
  if (existsSync(presets))
    cpSync(presets, join(folder, 'presets'), { recursive: true });
}

// main.ts hands this path to the Calendar and Reminders connectors.
copyFileSync(eventkitHelper, join(outdir, 'eventkit-helper'));
// Chats read the people model from beside the server.
copyFileSync(peopleFile, join(outdir, 'people.sql'));

const {
  outputFiles: [script],
} = await build({
  entryPoints: ['apps/apple/plugin/src/page/main.tsx'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  minify: true,
  jsx: 'automatic',
  tsconfig: 'apps/apple/plugin/src/page/tsconfig.json',
  logLevel: 'warning',
});
// OpenAI's MCP App styles map ChatGPT's theme onto the page; page.css lays it
// out.
const styles = [
  fileURLToPath(import.meta.resolve('@openai/mcp-extensions/app/styles.css')),
  'apps/apple/plugin/src/page/page.css',
]
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
writeFileSync(
  join(outdir, 'page.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apple</title>
<style>${styles}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${script.text}</script>
</body>
</html>
`,
);
