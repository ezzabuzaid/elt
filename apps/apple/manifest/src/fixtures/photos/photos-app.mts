import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AppleApp } from '@workspace/apple/apps/apple-app';
import type { Choice } from '@workspace/apple/apps/choice';
import {
  Catalog,
  type ExtractionCoverage,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

// A connector outside the library, as an agent writes one: TypeScript that
// Node runs as written, on the host's elt and AppleApp. It reads
// ~/Pictures/photos.json, a list of { id, title }.

const photos = new Stream({
  name: 'photos',
  jsonSchema: {
    type: 'object',
    description: 'One photo in the library.',
    properties: {
      id: { type: 'string', description: 'The photo identifier.' },
      title: { type: 'string', description: 'The photo title.' },
    },
  },
  primaryKey: ['id'],
  sourceDefinedCursor: true,
  supportedSyncModes: ['full_refresh', 'incremental'],
});

class PhotosSource extends Source {
  readonly identity = 'photos';
  protected readonly catalog = new Catalog([photos]);

  coverage(): ExtractionCoverage {
    return { description: 'every photo in photos.json', selection: {} };
  }

  protected async open() {
    return new AsyncDisposableStack();
  }

  protected async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected async *extract() {
    const listed: unknown = JSON.parse(
      await readFile(join(homedir(), 'Pictures/photos.json'), 'utf8'),
    );
    if (!Array.isArray(listed)) throw new TypeError('photos.json is a list');
    for (const photo of listed) yield { stream: 'photos', data: photo };
    yield { type: 'STATE' as const, stream: 'photos', state: {} };
  }
}

export default class PhotosApp extends AppleApp {
  readonly name = 'photos';
  readonly title = 'Photos';
  readonly datedBy = null;
  readonly fullDiskAccess = true;
  protected readonly choices: readonly Choice[] = [];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Open Photos once.';
  }

  protected source(): Source {
    return new PhotosSource();
  }
}
