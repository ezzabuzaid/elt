import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  Catalog,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Settings } from '@workspace/settings';

import { AppleConnector } from './apple-connector.ts';

// An app whose store lists two notes. Each read records the cursor it was
// handed; a read from the start pauses after the first note until the test
// lets it go on.
class TwoNotesSource extends Source {
  readonly identity = 'two-notes';
  protected readonly catalog = new Catalog([
    new Stream({
      name: 'notes',
      jsonSchema: {
        type: 'object',
        description: 'One note.',
        properties: { id: { type: 'string', description: 'The note.' } },
        required: ['id'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['incremental'],
      sourceDefinedCursor: true,
    }),
  ]);
  readonly #reads: unknown[];
  readonly #pause: () => Promise<void>;

  constructor(reads: unknown[], pause: () => Promise<void>) {
    super();
    this.#reads = reads;
    this.#pause = pause;
  }

  override coverage() {
    return { description: 'Every note.', selection: {} };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(
    _configuration: unknown,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    this.#reads.push(state);
    const resumed =
      typeof state === 'object' &&
      state !== null &&
      'after' in state &&
      state.after === 1;
    if (!resumed) {
      yield { stream: 'notes', data: { id: 'n1' } };
      yield { type: 'STATE', stream: 'notes', state: { after: 1 } };
      await this.#pause();
    }
    yield { stream: 'notes', data: { id: 'n2' } };
    yield { type: 'STATE', stream: 'notes', state: { after: 2 } };
  }
}

// An app with one file in its store, whose copy the import stores.
class OneFileSource extends Source {
  readonly identity = 'one-file';
  protected readonly catalog = new Catalog([
    new Stream({
      name: 'documents',
      jsonSchema: {
        type: 'object',
        description: 'One file.',
        properties: { name: { type: 'string', description: 'The file.' } },
        required: ['name'],
      },
      primaryKey: ['name'],
      supportedSyncModes: ['incremental'],
      supportsFileTransfer: true,
      sourceDefinedCursor: true,
    }),
  ]);
  readonly #file: string;

  constructor(file: string) {
    super();
    this.#file = file;
  }

  override coverage() {
    return { description: 'The file.', selection: {} };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(): AsyncGenerator<SourceMessage> {
    yield {
      stream: 'documents',
      data: { name: 'invoice.txt' },
      file: this.#file,
    };
    yield { type: 'STATE', stream: 'documents', state: null };
  }
}

class OneSourceConnector extends AppleConnector {
  readonly datedBy = null;
  readonly fullDiskAccess = false;
  protected readonly choices = [];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];
  readonly #source: Source;

  constructor(source: Source) {
    super(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: 'one-source', title: 'One Source', folder: '/nonexistent' },
    );
    this.#source = source;
  }

  protected access(): string {
    return 'Nothing to grant.';
  }

  protected source() {
    return this.#source;
  }
}

test(
  'an import whose signal aborts stops at its next note, records the pass cancelled and no failure, and the next import resumes from the saved cursor',
  { timeout: 10_000 },
  async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'import-'));
    const reads: unknown[] = [];
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const connector = new OneSourceConnector(
      new TwoNotesSource(reads, () => {
        paused.resolve();
        return resume.promise;
      }),
    );
    using settings = new Settings(join(scratch.path, 'Apple'));
    const selection = {
      connector: connector.name,
      scope: {},
      includeAttachments: false,
    };
    settings.select([selection], {
      facts: () => connector,
      permissions: () => connector.guidance(),
    });
    const stop = new AbortController();
    const lost = 'The flight is no longer this pass’s';
    const first = connector.import(settings, selection, undefined, stop.signal);
    const stopped = assert.rejects(first, (error) => error === lost);
    await paused.promise;

    stop.abort(lost);
    resume.resolve();
    await stopped;
    // What status shows until the next pass: a stop is not a failure.
    const failure = settings.connectionFailure(selection);
    const next = await connector.import(settings, selection);

    assert.equal(failure, undefined);
    assert.deepEqual(next, { status: 'imported' });
    assert.deepEqual(reads.slice(1), [{ after: 1 }]);
    using database = new DatabaseSync(settings.database(selection), {
      readOnly: true,
    });
    assert.deepEqual(
      database
        .prepare('SELECT status FROM sync_attempts ORDER BY attempt_id')
        .all()
        .map(({ status }) => status),
      ['cancelled', 'succeeded'],
    );
    assert.deepEqual(
      database
        .prepare('SELECT id FROM notes ORDER BY id')
        .all()
        .map(({ id }) => id),
      ['n1', 'n2'],
    );
  },
);

test(
  'a pass whose process was killed is recorded failed once the next import begins, and that import resumes from its last checkpoint',
  { timeout: 30_000 },
  async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'import-'));
    using settings = new Settings(join(scratch.path, 'Apple'));
    const reads: unknown[] = [];
    const connector = new OneSourceConnector(
      new TwoNotesSource(reads, async () => {}),
    );
    const selection = {
      connector: connector.name,
      scope: {},
      includeAttachments: false,
    };
    settings.select([selection], {
      facts: () => connector,
      permissions: () => connector.guidance(),
    });
    // The same import in a process of its own, whose source commits the
    // first note and then waits until the process is killed, as a process
    // that runs out of memory or is quit mid-pass leaves its pass.
    const pass = `
      const { Catalog, Source, Stream } = await import('@workspace/elt');
      const { Settings } = await import('@workspace/settings');
      const { AppleConnector } = await import(process.env.CONNECTOR);
      class TwoNotesSource extends Source {
        identity = 'two-notes';
        catalog = new Catalog([new Stream({
          name: 'notes',
          jsonSchema: {
            type: 'object',
            description: 'One note.',
            properties: { id: { type: 'string', description: 'The note.' } },
            required: ['id'],
          },
          primaryKey: ['id'],
          supportedSyncModes: ['incremental'],
          sourceDefinedCursor: true,
        })]);
        coverage() { return { description: 'Every note.', selection: {} }; }
        async open() { return new AsyncDisposableStack(); }
        async *observe({ streams }) { yield streams; }
        async *extract() {
          yield { stream: 'notes', data: { id: 'n1' } };
          yield { type: 'STATE', stream: 'notes', state: { after: 1 } };
          process.stdout.write('paused\\n');
          await new Promise(() => setInterval(() => {}, 1 << 30));
        }
      }
      class OneSourceConnector extends AppleConnector {
        datedBy = null;
        fullDiskAccess = false;
        choices = [];
        unscoped = [];
        storeCopies = [];
        constructor() {
          super({ grantee: 'Codex', eventKitHelper: '' }, { name: 'one-source', title: 'One Source', folder: '/nonexistent' });
        }
        access() { return 'Nothing to grant.'; }
        source() { return new TwoNotesSource(); }
      }
      await new OneSourceConnector().import(new Settings(process.env.APPLE), JSON.parse(process.env.SELECTION));
    `;
    const killed = spawn(
      process.execPath,
      ['--input-type=module', '-e', pass],
      {
        cwd: join(import.meta.dirname, '..'),
        env: {
          ...process.env,
          CONNECTOR: pathToFileURL(
            join(import.meta.dirname, 'apple-connector.js'),
          ).href,
          APPLE: join(scratch.path, 'Apple'),
          SELECTION: JSON.stringify(selection),
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    await once(killed.stdout, 'data');
    killed.kill('SIGKILL');
    await once(killed, 'exit');

    const next = await connector.import(settings, selection);

    assert.deepEqual(next, { status: 'imported' });
    assert.deepEqual(reads, [{ after: 1 }]);
    using database = new DatabaseSync(settings.database(selection), {
      readOnly: true,
    });
    assert.deepEqual(
      database
        .prepare(
          'SELECT status, error, failure_type FROM sync_attempts ORDER BY attempt_id',
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          status: 'failed',
          error: 'The process running this pass ended before the pass did',
          failure_type: 'system',
        },
        { status: 'succeeded', error: null, failure_type: null },
      ],
    );
    assert.deepEqual(
      database
        .prepare(
          'SELECT attempt_id, stream, status FROM extraction_coverage ORDER BY attempt_id',
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { attempt_id: 1, stream: 'notes', status: 'failed' },
        { attempt_id: 2, stream: 'notes', status: 'succeeded' },
      ],
    );
  },
);

test(
  'an import whose signal aborts once its pass committed reads no text of the files it stored, and the next import reads it',
  { timeout: 30_000 },
  async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'import-'));
    const file = join(scratch.path, 'Store/invoice.txt');
    await mkdir(join(scratch.path, 'Store'));
    await writeFile(file, 'Careem invoice 4471');
    const connector = new OneSourceConnector(new OneFileSource(file));
    using settings = new Settings(join(scratch.path, 'Apple'));
    const selection = {
      connector: connector.name,
      scope: {},
      includeAttachments: true,
    };
    settings.select([selection], {
      facts: () => connector,
      permissions: () => connector.guidance(),
    });
    const texts = () => {
      using database = new DatabaseSync(settings.database(selection), {
        readOnly: true,
      });
      return database
        .prepare('SELECT content FROM attachment_text')
        .all()
        .map(({ content }) => content);
    };
    const stop = new AbortController();
    // The pass is recorded before its observer hears it ended, so the signal
    // aborts between the pass and the reading of the text.
    const aborting = {
      begin: () => ({
        progress: () => undefined,
        fail: () => undefined,
        finish: () => stop.abort(),
      }),
    };

    const first = await connector.import(
      settings,
      selection,
      aborting,
      stop.signal,
    );
    const unread = texts();
    const next = await connector.import(settings, selection);

    assert.deepEqual(first, { status: 'imported' });
    assert.deepEqual(unread, []);
    assert.deepEqual(next, { status: 'imported' });
    assert.deepEqual(texts(), ['Careem invoice 4471']);
  },
);
