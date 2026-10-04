import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AppleApp,
  AppleHost,
} from '@workspace/connector-apple-app/apple-app';

import { ConnectorManifest } from './connector-manifest.ts';

// A connector that did not load, titled by its manifest, or by its folder
// when the manifest cannot be read.
export type BrokenConnector = {
  readonly title: string;
  readonly error: string;
};

// The Apple apps found in the folders a host reads: each subfolder whose
// package.json declares a connector. A connector that cannot be read or
// loaded is reported with its error, and the others still load.
export class Connectors {
  readonly #roots: readonly string[];

  constructor(roots: readonly string[]) {
    this.#roots = roots;
  }

  async load(
    host: AppleHost,
  ): Promise<{ apps: AppleApp[]; broken: BrokenConnector[] }> {
    const apps: AppleApp[] = [];
    const broken: BrokenConnector[] = [];
    for (const folder of this.#folders()) {
      const failed = (title: string, error: unknown) =>
        broken.push({
          title,
          error: error instanceof Error ? error.message : String(error),
        });
      let manifest: ConnectorManifest | undefined;
      try {
        manifest = ConnectorManifest.read(folder);
      } catch (error) {
        failed(folder, error);
        continue;
      }
      if (manifest === undefined) continue;
      if (apps.some(({ name }) => name === manifest.name)) {
        failed(manifest.title, `Another connector is named ${manifest.name}.`);
        continue;
      }
      try {
        apps.push(await manifest.load(host));
      } catch (error) {
        failed(manifest.title, error);
      }
    }
    return { apps, broken };
  }

  // What each root holds, root by root and by name within a root, for
  // ConnectorManifest.read to tell connector folders from the rest; a root
  // that does not exist yet holds none.
  *#folders(): Generator<string> {
    for (const root of this.#roots) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root).sort()) yield join(root, name);
    }
  }
}
