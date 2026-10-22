import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempDisposable, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Catalog,
  type CopyConfiguration,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import type { SQLiteView } from '@workspace/elt-sqlite';
import { Settings } from '@workspace/settings';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

import { AppleConnector } from './apple-connector.ts';

// A source whose upstream is current whenever it is read.
abstract class LiveSource<
  Context extends AsyncDisposable = AsyncDisposable,
> extends Source<Context> {
  override async currentAsOf() {
    return null;
  }
}

const stream = (name: string) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: `One ${name} record.`,
      properties: { id: { type: 'string', description: 'The record.' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
  });

// An app with two stores: people always reads, and calls fails to read while
// the file broken exists beside it.
class TwoStoreSource extends LiveSource {
  readonly identity = 'two-stores';
  protected readonly catalog = new Catalog([stream('people'), stream('calls')]);
  readonly #broken: string;

  constructor(broken: string) {
    super();
    this.#broken = broken;
  }

  override coverage() {
    return { description: 'Every record.', selection: {} };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract({
    stream: { name },
  }: CopyConfiguration): AsyncGenerator<SourceMessage> {
    if (name === 'calls' && existsSync(this.#broken))
      throw new Error('calls cannot be read');
    yield { stream: name, data: { id: `${name}-1` } };
    yield { type: 'STATE', stream: name, state: null };
  }
}

// A connector with views over its stores' views.
class TwoStoreConnector extends AppleConnector {
  readonly datedBy = null;
  readonly fullDiskAccess = false;
  protected readonly choices = [];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];
  readonly #broken: string;
  readonly #views: readonly SQLiteView[];

  constructor(broken: string, views: readonly SQLiteView[]) {
    super(
      {
        grantee: 'Codex',
        documentParser: new MacOSDocumentParser(),
        eventKitHelper: '',
      },
      { name: 'two-stores', title: 'Two Stores', folder: '/nonexistent' },
    );
    this.#broken = broken;
    this.#views = views;
  }

  protected override views() {
    return this.#views;
  }

  protected access(): string {
    return 'Nothing to grant.';
  }

  protected source() {
    return new TwoStoreSource(this.#broken);
  }
}

const everyone: SQLiteView = {
  name: 'everyone',
  description: 'Each person.',
  columns: { person: 'A people id.' },
  query: 'SELECT id AS person FROM people',
};

const both: SQLiteView = {
  name: 'both',
  description: 'Each person with each call.',
  columns: { person: 'A people id.', call: 'A calls id.' },
  query: 'SELECT p.id AS person, c.id AS call FROM people p, calls c',
};

async function imports(directory: string, views: readonly SQLiteView[]) {
  const broken = join(directory, 'broken');
  const connector = new TwoStoreConnector(broken, views);
  const settings = new Settings(join(directory, 'Apple'));
  const selection = {
    connector: connector.name,
    scope: {},
    includeAttachments: false,
  };
  settings.select([selection], {
    facts: () => connector,
    permissions: () => connector.guidance(),
  });
  return {
    settings,
    selection,
    break: () => writeFile(broken, ''),
    repair: () => rm(broken),
    import: () => connector.import(settings, selection),
    views: () => {
      using database = new DatabaseSync(settings.database(selection), {
        readOnly: true,
      });
      return database
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'view' AND name IN ('both', 'everyone')
           UNION ALL SELECT name FROM catalog WHERE name IN ('both', 'everyone') ORDER BY name`,
        )
        .all()
        .map(({ name }) => name);
    },
  };
}

test("a connector's view that reads a stream whose first pass failed waits for it without failing the import, its other views publish, and it is published once the stream loaded", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'views-'));
  const app = await imports(scratch.path, [both, everyone]);
  try {
    await app.break();

    // The calls failure is in the sync history; both has nothing to read yet.
    assert.deepEqual(await app.import(), { status: 'imported' });
    assert.deepEqual(app.views(), ['everyone', 'everyone']);
    assert.equal(app.settings.connectionFailure(app.selection), undefined);

    await app.repair();
    assert.deepEqual(await app.import(), { status: 'imported' });

    // Published, and described in the catalog.
    assert.deepEqual(app.views(), ['both', 'both', 'everyone', 'everyone']);
  } finally {
    app.settings[Symbol.dispose]();
  }
});

test('a view that cannot be published once every stream loaded fails the import, which the settings keep', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'views-'));
  const app = await imports(scratch.path, [
    {
      ...both,
      query: 'SELECT p.id AS person, c.missing AS call FROM people p, calls c',
    },
  ]);
  try {
    await assert.rejects(app.import(), /no such column: c\.missing/);
    assert.match(
      app.settings.connectionFailure(app.selection)?.error ?? '',
      /no such column: c\.missing/,
    );
  } finally {
    app.settings[Symbol.dispose]();
  }
});
