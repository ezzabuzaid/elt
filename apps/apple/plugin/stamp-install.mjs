// Gives the copy `install` adds a version of its own. ChatGPT keeps the Apple
// page's HTML per plugin version, so a reinstall at the same version opens the
// last install's page against the new server; a new version makes it reload
// the page. Only the local install runs this: a release bumps the version.
import { readFileSync, writeFileSync } from 'node:fs';

const manifest =
  'dist/apple-plugin-marketplace/plugins/apple/.codex-plugin/plugin.json';
const plugin = JSON.parse(readFileSync(manifest, 'utf8'));
plugin.version = `${plugin.version}-dev.${Date.now()}`;
writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`);
