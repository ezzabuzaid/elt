import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockTranscriptionModelV4 } from 'ai/test';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  LocalFiles,
  Pipeline,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import { AudioFormat } from '@workspace/source-apple-macos/audio-format';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

import { AttachmentText } from './attachment-text.ts';

// A source whose upstream is current whenever it is read.
abstract class LiveSource<
  Context extends AsyncDisposable = AsyncDisposable,
> extends Source<Context> {
  override async currentAsOf() {
    return null;
  }
}

// The import whose stored files the text reads: one record per file in a
// folder, its copy stored through LocalFiles as AppleConnector stores
// attachments, and deleted once its file is.
const documents = new Stream({
  name: 'documents',
  jsonSchema: {
    type: 'object',
    description: 'One record per file in the folder.',
    properties: {
      name: { type: 'string', description: 'The file name in the folder.' },
    },
    required: ['name'],
  },
  primaryKey: ['name'],
  supportedSyncModes: ['incremental'],
  supportsFileTransfer: true,
  sourceDefinedCursor: true,
  emitsDeletes: true,
});

class FolderSource extends LiveSource {
  readonly identity = 'folder';
  protected readonly catalog = new Catalog([documents]);
  readonly #folder: string;

  constructor(folder: string) {
    super();
    this.#folder = folder;
  }

  override coverage() {
    return { description: 'Every file in the folder.', selection: {} };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  // Every file each run, and a deletion for each file gone since the last.
  protected override async *extract(
    _configuration: CopyConfiguration,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    const names = (await readdir(this.#folder)).sort();
    for (const name of names)
      yield {
        stream: 'documents',
        data: { name },
        file: join(this.#folder, name),
      };
    if (Array.isArray(state))
      for (const name of state)
        if (typeof name === 'string' && !names.includes(name))
          yield { type: 'DELETE', stream: 'documents', key: { name } };
    yield { type: 'STATE', stream: 'documents', state: names };
  }
}

// One import as AppleConnector keeps it: its tables, views and stored copies
// beside one data.sqlite, and the attachment text read from them.
async function importStore(directory: string) {
  const upstream = join(directory, 'upstream');
  await mkdir(upstream, { recursive: true });
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog({ path });
  const imported = new Connection({
    name: 'import',
    source: new FolderSource(upstream),
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(directory, 'checkpoints.sqlite'),
    }),
    steps: [
      new Copy(
        documents,
        destination
          .table('raw_documents', (columns) => [
            ...SQLiteColumns.fromSchema(documents.jsonSchema),
            columns.text('attachmentRef').from(documents.file.store(files)),
          ])
          .withReaderView('documents'),
        {
          id: 'documents',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        },
      ),
    ],
  });
  const read = (sql: string) => {
    using database = new DatabaseSync(path, { readOnly: true });
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  };
  return {
    put: (name: string, content: string) =>
      writeFile(join(upstream, name), content),
    remove: (name: string) => rm(join(upstream, name)),
    importFiles: () => new Pipeline({ history, connections: [imported] }).run(),
    readText: (parser: DocumentParser, signal = new AbortController().signal) =>
      new AttachmentText(
        path,
        files.directory,
        ['documents'],
        () => parser,
      ).update(signal),
    read,
    // What a reader searching attachment text sees, by document; none before
    // the text's first update creates its view.
    texts: () =>
      read(
        `SELECT 1 FROM sqlite_schema WHERE name IN ('attachment_text', 'documents')`,
      ).length < 2
        ? []
        : read(
            `SELECT d.name, t.status, t.content, t.error, t.parser
             FROM documents d JOIN attachment_text t ON t.ref = d.attachmentRef
             ORDER BY d.name`,
          ),
  };
}

// The real parser, counting what it is asked to read: whether an update
// read a file has no other output a test can see.
class CountingParser extends DocumentParser {
  readonly read: string[] = [];
  readonly #parser = new MacOSDocumentParser();

  constructor(identity = new MacOSDocumentParser().identity) {
    super(identity);
  }

  override identityFor(path: string) {
    return this.identity === this.#parser.identity
      ? this.#parser.identityFor(path)
      : super.identityFor(path);
  }

  override parse(path: string) {
    this.read.push(path);
    return this.#parser.parse(path);
  }
}

// The real parser, holding each file whose text contains "hold" until
// release(). The real one cannot be made to take long on demand.
class HoldingParser extends DocumentParser {
  inFlight = 0;
  peak = 0;
  readonly #parser = new MacOSDocumentParser();
  readonly #release = Promise.withResolvers<void>();

  constructor() {
    super(new MacOSDocumentParser().identity);
  }

  override identityFor(path: string) {
    return this.#parser.identityFor(path);
  }

  release() {
    this.#release.resolve();
  }

  override async parse(path: string) {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if ((await readFile(path, 'utf8')).includes('hold'))
        await this.#release.promise;
      return await this.#parser.parse(path);
    } finally {
      this.inFlight -= 1;
    }
  }
}

// Waits until check() holds, polling, or fails after a deadline.
async function eventually(check: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// One page with a line of text in Helvetica: a PDF with a text layer.
function textPdf(text: string): string {
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

test('an unreadable file loads as failed with its error, and the update still reads every other file', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('invoice.txt', 'Careem invoice 4471');
  await store.put('corrupt.pdf', 'not a pdf');
  await store.put('note.txt', 'Dinner at eight');
  await store.importFiles();

  await store.readText(new MacOSDocumentParser());

  const texts = store.texts();
  assert.deepEqual(
    texts.map(({ name, status, content }) => ({ name, status, content })),
    [
      { name: 'corrupt.pdf', status: 'failed', content: null },
      { name: 'invoice.txt', status: 'parsed', content: 'Careem invoice 4471' },
      { name: 'note.txt', status: 'parsed', content: 'Dinner at eight' },
    ],
  );
  assert.match(String(texts[0]?.error), /Cannot read PDF/);
});

test('a file whose read failed is read again on the next update', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('invoice.txt', 'Careem invoice 4471');
  await store.importFiles();
  // The real parser fails only for reasons a test cannot switch on and off,
  // such as Vision under a sandbox or an osascript timeout.
  const flaky = new (class extends DocumentParser {
    failures = 1;
    readonly #parser = new MacOSDocumentParser();
    override parse(path: string) {
      if (this.failures-- > 0) throw new Error('Vision failed');
      return this.#parser.parse(path);
    }
  })(new MacOSDocumentParser().identity);
  await store.readText(flaky);
  assert.equal(store.texts()[0]?.status, 'failed');

  await store.readText(flaky);

  assert.deepEqual(
    store.texts().map(({ status, content }) => ({ status, content })),
    [{ status: 'parsed', content: 'Careem invoice 4471' }],
  );
});

test('a stored copy removed while it is read leaves no row and no failure', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('invoice.txt', 'Careem invoice 4471');
  await store.importFiles();
  // Only a commit that lands mid-read removes a copy, and a test cannot time
  // a real commit into that window, so the parser removes it first.
  const racing = new (class extends DocumentParser {
    readonly #parser = new MacOSDocumentParser();
    override async parse(path: string) {
      await rm(path);
      return this.#parser.parse(path);
    }
  })(new MacOSDocumentParser().identity);

  await store.readText(racing);

  assert.deepEqual(store.read('SELECT ref, status FROM attachment_text'), []);
});

test('a file that is slow to read holds only its own place: four read at once and the rest go on', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('a-slow.txt', 'hold until released');
  for (const name of ['b', 'c', 'd', 'e', 'f', 'g'])
    await store.put(`${name}.txt`, `text of ${name}`);
  await store.importFiles();
  const parser = new HoldingParser();

  const update = store.readText(parser);
  await eventually(
    () => parser.inFlight === 1 && parser.peak === 4,
    'every file but the held one to be read',
  );
  parser.release();
  await update;

  assert.equal(parser.peak, 4);
  assert.deepEqual(
    store.texts().map(({ name, status }) => [name, status]),
    ['a-slow', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => [
      `${name}.txt`,
      'parsed',
    ]),
  );
});

test('an import loads and commits its rows while a file is still being read', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('slow.txt', 'hold until released');
  await store.importFiles();
  const parser = new HoldingParser();
  const update = store.readText(parser);
  try {
    await eventually(() => parser.inFlight === 1, 'the held read to start');
    await store.put('invoice.txt', 'Careem invoice 4471');

    await store.importFiles();

    assert.deepEqual(store.read('SELECT name FROM documents ORDER BY name'), [
      { name: 'invoice.txt' },
      { name: 'slow.txt' },
    ]);
    assert.equal(parser.inFlight, 1);
  } finally {
    parser.release();
    await update;
  }
});

test('an update stopped while files are read keeps the text it read, and the next update reads the rest', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  // Whichever four start first stay held, so the other two remain queued.
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f'])
    await store.put(`${name}-held.txt`, `hold ${name}`);
  await store.importFiles();
  const parser = new HoldingParser();
  const stop = new AbortController();
  const update = store.readText(parser, stop.signal);
  await eventually(() => parser.inFlight === 4, 'four held reads');
  stop.abort();
  parser.release();
  await update;
  // The four reads that started kept their text; the queue's order is the
  // stored copies', so which four is not fixed.
  assert.equal(store.texts().length, 4);
  const counting = new CountingParser();

  await store.readText(counting);

  assert.equal(counting.read.length, 2);
  assert.equal(store.texts().length, 6);
});

test('a read that fails for a reason other than the file being gone fails the update, and stops it taking more files', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    await store.put(`${name}.txt`, `text ${name}`);
  await store.importFiles();
  const ref = join(
    directory.path,
    'files',
    String(store.read('SELECT attachmentRef AS ref FROM documents')[0]?.ref),
  );
  // The stored copies' directory, unreadable, as permissions can leave it:
  // the parser cannot open a copy, nor the update tell whether it is gone.
  await chmod(dirname(ref), 0o000);
  const parser = new CountingParser();
  try {
    await assert.rejects(store.readText(parser), /EACCES/);

    assert.ok(parser.read.length <= 4, `read ${parser.read.length} files`);
  } finally {
    await chmod(dirname(ref), 0o700);
  }
});

test('an update before the import committed anything reads nothing and fails nothing', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  const parser = new CountingParser();

  await store.readText(parser);

  assert.deepEqual(parser.read, []);
  assert.deepEqual(store.read('SELECT ref FROM attachment_text'), []);
});

test('a reader finds a stored file by its text: text and PDF files load their text, a file with no text loads no_text', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('note.txt', 'Dinner at eight');
  await store.put('receipt.pdf', textPdf('Careem invoice 4471'));
  await store.put('blob.bin', '\u0001\u0002\u0003 binary');
  await store.importFiles();

  await store.readText(new MacOSDocumentParser());

  assert.deepEqual(
    store.read(
      `SELECT d.name FROM documents d JOIN attachment_text t ON t.ref = d.attachmentRef
       WHERE t.content LIKE '%invoice 4471%'`,
    ),
    [{ name: 'receipt.pdf' }],
  );
  assert.deepEqual(
    store.texts().map(({ name, status }) => [name, status]),
    [
      ['blob.bin', 'no_text'],
      ['note.txt', 'parsed'],
      ['receipt.pdf', 'parsed'],
    ],
  );
  for (const { ref, sha256 } of store.read(
    'SELECT ref, sha256 FROM attachment_text',
  )) {
    assert.match(String(sha256), /^[0-9a-f]{64}$/);
    assert.equal(basename(String(ref), extname(String(ref))), sha256);
  }
  assert.deepEqual(
    store.read(
      `SELECT name FROM catalog WHERE name LIKE 'attachment_text%' ORDER BY name`,
    ),
    [
      'attachment_text',
      ...['content', 'error', 'parser', 'ref', 'sha256', 'status'].map(
        (column) => `attachment_text.${column}`,
      ),
    ].map((name) => ({ name })),
  );
});

test('an update with nothing new reads no file', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('note.txt', 'Dinner at eight');
  await store.put('invoice.txt', 'Careem invoice 4471');
  await store.put('blob.bin', '\u0001\u0002\u0003 binary');
  await store.importFiles();
  await store.readText(new MacOSDocumentParser());
  const parser = new CountingParser();

  await store.readText(parser);

  assert.deepEqual(parser.read, []);
  assert.equal(store.texts().length, 3);
});

test('a parser with a new identity reads every file again', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('note.txt', 'Dinner at eight');
  await store.put('invoice.txt', 'Careem invoice 4471');
  await store.importFiles();
  await store.readText(new MacOSDocumentParser());
  const upgraded = new CountingParser('macos-document-next');

  await store.readText(upgraded);

  assert.equal(upgraded.read.length, 2);
  assert.deepEqual(
    store.texts().map(({ name, parser }) => [name, parser]),
    [
      ['invoice.txt', 'macos-document-next'],
      ['note.txt', 'macos-document-next'],
    ],
  );
});

test('a file the import deletes loses its text on the next update', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  await store.put('note.txt', 'Dinner at eight');
  await store.put('invoice.txt', 'Careem invoice 4471');
  await store.importFiles();
  await store.readText(new MacOSDocumentParser());
  await store.remove('invoice.txt');
  await store.importFiles();

  await store.readText(new MacOSDocumentParser());

  assert.deepEqual(store.read('SELECT content FROM attachment_text'), [
    { content: 'Dinner at eight' },
  ]);
});

test('one file attached in three chats is read once, and all three find its text', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const store = await importStore(directory.path);
  for (const chat of ['family', 'work', 'friends'])
    await store.put(`${chat}-invoice.txt`, 'Careem invoice 4471');
  await store.importFiles();
  const parser = new CountingParser();

  await store.readText(parser);

  assert.equal(parser.read.length, 1);
  assert.deepEqual(
    store.texts().map(({ name, content }) => [name, content]),
    ['family', 'friends', 'work'].map((chat) => [
      `${chat}-invoice.txt`,
      'Careem invoice 4471',
    ]),
  );
});

// AI SDK's provider stand-in lets one test change a model's answer without
// credentials or downloading different weights. Dispatch and storage are real.
test('enabling or changing an audio model processes stored audio; disabling keeps its transcript', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-audio-'));
  const store = await importStore(directory.path);
  await store.put('note.txt', 'Keep this document');
  await store.put('voice.opus', '\u0000audio');
  await store.importFiles();
  await store.readText(new MacOSDocumentParser());
  assert.equal(store.texts()[1]?.status, 'no_text');
  const model = (id: string) =>
    new MockTranscriptionModelV4({
      modelId: id,
      doGenerate: async () => ({
        text: id,
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: { timestamp: new Date(), modelId: id },
      }),
    });
  const parser = new MacOSDocumentParser([new AudioFormat(model('first'))]);
  await store.readText(parser);
  assert.deepEqual(
    store.texts().map(({ content }) => content),
    ['Keep this document', 'first'],
  );
  // A native document already read keeps its existing identity and content.
  const document = store.texts()[0];
  await store.readText(
    new MacOSDocumentParser([new AudioFormat(model('second'))]),
  );
  assert.deepEqual(store.texts()[0], document);
  assert.equal(store.texts()[1]?.content, 'second');
  await store.readText(new MacOSDocumentParser());
  assert.equal(store.texts()[1]?.content, 'second');
  await store.put('new.opus', '\u0000new audio');
  await store.importFiles();
  await store.readText(new MacOSDocumentParser());
  assert.equal(
    store.texts().find(({ name }) => name === 'new.opus')?.status,
    'no_text',
  );
});

test('a moved import reads the text of its stored files', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'att-'));
  const before = join(directory.path, 'before');
  const after = join(directory.path, 'after');
  const store = await importStore(before);
  await store.put('note.txt', 'milk and eggs');
  await store.importFiles();

  // The import's folder moves to another disk or home, files and all.
  await rename(before, after);
  await new AttachmentText(
    join(after, 'data.sqlite'),
    join(after, 'files'),
    ['documents'],
    () => new MacOSDocumentParser(),
  ).update(new AbortController().signal);

  using database = new DatabaseSync(join(after, 'data.sqlite'), {
    readOnly: true,
  });
  assert.deepEqual(
    database
      .prepare(
        'SELECT d.name, t.status, t.content FROM documents d JOIN attachment_text t ON t.ref = d.attachmentRef',
      )
      .all()
      .map((row) => ({ ...row })),
    [{ name: 'note.txt', status: 'parsed', content: 'milk and eggs' }],
  );
});
