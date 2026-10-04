import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import {
  AppleApp,
  type AppleHost,
} from '@workspace/connector-apple-app/apple-app';

// A connector folder's connector.json: the app's name and title, and the
// entry point whose default export is the app's class, relative to the folder.
const manifestSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  entry: z.string().startsWith('./'),
});

type AppleAppClass = new (host: AppleHost) => AppleApp;

// What a connector folder says it is, read without running its code.
export class ConnectorManifest {
  readonly name: string;
  readonly title: string;
  readonly #entry: string;

  constructor(folder: string) {
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(folder, 'connector.json'), 'utf8')),
    );
    this.name = manifest.name;
    this.title = manifest.title;
    this.#entry = join(folder, manifest.entry);
  }

  // Runs the entry point and creates its app for the host. Node keeps a
  // module it loaded, so the entry's URL carries its modification time: an
  // edited entry loads again. Files it imports load once.
  async load(host: AppleHost): Promise<AppleApp> {
    const entry = pathToFileURL(this.#entry);
    entry.searchParams.set('modified', String(statSync(this.#entry).mtimeMs));
    const { default: App }: { default?: unknown } = await import(entry.href);
    if (!isAppleAppClass(App))
      throw new TypeError(
        `${this.#entry} does not export an AppleApp class by default.`,
      );
    const app = new App(host);
    if (app.name !== this.name)
      throw new TypeError(
        `${this.#entry} names its app ${app.name}, but its manifest names ${this.name}.`,
      );
    return app;
  }
}

function isAppleAppClass(value: unknown): value is AppleAppClass {
  return typeof value === 'function' && value.prototype instanceof AppleApp;
}
