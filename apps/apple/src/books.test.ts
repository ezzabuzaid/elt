import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  PipelineError,
  StreamStatus,
} from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import { appleWarehouse } from './fixtures/apple-warehouse.ts';
import {
  booksFixture,
  defaultHistory,
  readingHistoryDocument,
} from './fixtures/books-stores.ts';
import { writePlist } from './fixtures/safari-stores.ts';
import {
  BooksSchemaError,
  BooksUnavailableError,
  booksContainer,
  booksGroupContainer,
} from './platform/macos/books-store.ts';
import { AppleBooksSource } from './sources/apple-books/apple-books-source.ts';

const run = promisify(execFile);
const rows = <T extends object>(found: Iterable<T>) =>
  [...found].map((row) => ({ ...row }));

test('Books reads its library, annotations, synced reading state and reading history as documented views', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  await using warehouse = await appleWarehouse(
    'books',
    new AppleBooksSource(location),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;

  await warehouse.load();

  assert.deepEqual(
    (
      await agent`SELECT name FROM catalog WHERE kind = 'view' AND name LIKE 'books%' AND description <> '' GROUP BY name ORDER BY name`
    ).map(({ name }) => name),
    [
      'books_annotations',
      'books_asset_details',
      'books_book_files',
      'books_collection_members',
      'books_collections',
      'books_library_assets',
      'books_purchases',
      'books_reading_days',
      'books_reading_goal',
      'books_reading_months',
      'books_reviews',
      'books_streak_records',
      'books_themes',
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT "assetId", title, "contentType", "readingProgress"::text AS progress, "isFinished", "finishedAt", "seriesContainerAssetId" FROM books_library_assets ORDER BY "assetId"`,
    ),
    [
      {
        assetId: 'A1',
        title: 'Design for Developers',
        contentType: 'epub',
        progress: '0.5',
        isFinished: false,
        finishedAt: null,
        seriesContainerAssetId: null,
      },
      {
        assetId: 'G3',
        title: 'Gone',
        contentType: 'epub',
        progress: '0',
        isFinished: false,
        finishedAt: null,
        seriesContainerAssetId: 'A1',
      },
      {
        assetId: 'P2',
        title: 'Notes',
        contentType: 'pdf',
        progress: '1',
        isFinished: true,
        finishedAt: new Date('2023-08-21T10:00:00.000Z'),
        seriesContainerAssetId: null,
      },
      {
        assetId: 'Z4',
        title: 'Packed',
        contentType: 'epub',
        progress: '0',
        isFinished: false,
        finishedAt: null,
        seriesContainerAssetId: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT "collectionId", "assetId" FROM books_collection_members ORDER BY "collectionId"`,
    ),
    [
      { collectionId: '4F1E-WANT', assetId: 'LEFT' },
      { collectionId: 'Finished_Collection_ID', assetId: 'P2' },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT id, "assetId", kind, style::int, underline, deleted, "selectedText", note, chapter FROM books_annotations ORDER BY id`,
    ),
    [
      {
        id: 'D-4',
        assetId: null,
        kind: null,
        style: 0,
        underline: false,
        deleted: true,
        selectedText: null,
        note: null,
        chapter: null,
      },
      {
        id: 'H-1',
        assetId: 'A1',
        kind: 'highlight',
        style: 3,
        underline: false,
        deleted: false,
        selectedText: 'Grids and rhythm',
        note: 'Use a baseline',
        chapter: 'Chapter 4',
      },
      {
        id: 'R-3',
        assetId: 'A1',
        kind: 'readingPosition',
        style: 0,
        underline: false,
        deleted: false,
        selectedText: null,
        note: null,
        chapter: null,
      },
      {
        id: 'U-2',
        assetId: 'A1',
        kind: 'highlight',
        style: 0,
        underline: true,
        deleted: false,
        selectedText: 'underlined',
        note: null,
        chapter: 'Chapter 5',
      },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT "assetId", "notFinished", position FROM books_asset_details ORDER BY "assetId"`,
    ),
    [
      {
        assetId: 'A1',
        notFinished: true,
        position: 'epubcfi(/6/10!/4/2/1:0)',
      },
      { assetId: 'ELSEWHERE', notFinished: null, position: null },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT month, "summarizedSeconds"::int AS summarized, "lastDayStreakOrdinal"::int AS streak, "dayCount"::int AS days FROM books_reading_months ORDER BY month`,
    ),
    [
      { month: '2022-08', summarized: 9531, streak: 0, days: 0 },
      { month: '2026-09', summarized: null, streak: -1, days: 2 },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT date::text, month, "readingSeconds"::int AS seconds, "goalSeconds"::int AS goal FROM books_reading_days ORDER BY date`,
    ),
    [
      { date: '2026-09-08', month: '2026-09', seconds: 1296, goal: 1800 },
      // Two devices' contributions add up.
      { date: '2026-09-14', month: '2026-09', seconds: 43007, goal: 1800 },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT days::int, "reachedAt" FROM books_streak_records ORDER BY days`,
    ),
    [
      { days: 1, reachedAt: new Date('2021-12-09T22:00:00.000Z') },
      { days: 7, reachedAt: new Date('2023-02-06T21:00:00.000Z') },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT enabled, "dailyGoalSeconds"::int AS goal, "goalSetAt", "currentStreakDays"::int AS streak FROM books_reading_goal`,
    ),
    [
      {
        enabled: true,
        goal: 1800,
        goalSetAt: new Date('2022-03-05T08:02:05.000Z'),
        streak: 0,
      },
    ],
  );
  // Download tokens and DRM parameters never reach the warehouse.
  const purchase = rows(await agent`SELECT * FROM books_purchases`);
  assert.equal(purchase.length, 1);
  assert.equal(purchase[0]?.storeId, '1587320271');
  assert.doesNotMatch(JSON.stringify(purchase), /SECRET/);
  assert.deepEqual(
    rows(
      await agent`SELECT id, "boldText", "lineHeight"::text AS height FROM books_themes`,
    ),
    [{ id: 'Quiet', boldText: true, height: '1.4' }],
  );
});

test('Books stores each book on this Mac as one file, packing an EPUB directory into an .epub, and reports a missing one without a file', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  await using warehouse = await appleWarehouse(
    'books',
    new AppleBooksSource(location),
    join(scratch.path, 'outputs'),
  );

  await warehouse.load();
  const files = rows(
    await warehouse.agent`SELECT "assetId", format, "availableLocally", "fileCount"::int AS count, "attachmentRef" FROM books_book_files ORDER BY "assetId"`,
  );
  await warehouse.load();
  const again = rows(
    await warehouse.agent`SELECT "attachmentRef" FROM books_book_files ORDER BY "assetId"`,
  );

  assert.deepEqual(
    files.map(({ attachmentRef, ...file }) => ({
      ...file,
      stored: attachmentRef !== null,
    })),
    [
      {
        assetId: 'A1',
        format: 'epub-package',
        availableLocally: true,
        count: 4,
        stored: true,
      },
      {
        assetId: 'G3',
        format: 'epub-package',
        availableLocally: false,
        count: null,
        stored: false,
      },
      {
        assetId: 'P2',
        format: 'file',
        availableLocally: true,
        count: 1,
        stored: true,
      },
      // A zipped .epub is a single file, exported as it is.
      {
        assetId: 'Z4',
        format: 'file',
        availableLocally: true,
        count: 1,
        stored: true,
      },
    ],
  );
  const epub = files[0]?.attachmentRef as string;
  assert.match(epub, /\.epub$/);
  const listing = (await run('/usr/bin/unzip', ['-Z1', epub])).stdout
    .trim()
    .split('\n');
  assert.deepEqual(listing, [
    'mimetype',
    'META-INF/container.xml',
    'OEBPS/chapter.xhtml',
    'OEBPS/content.opf',
  ]);
  await run('/usr/bin/unzip', ['-tq', epub]);
  // The mimetype is the first entry's stored bytes, right after its header.
  assert.equal(
    (await readFile(epub)).subarray(38, 58).toString(),
    'application/epub+zip',
  );
  assert.equal(
    await readFile(files[2]?.attachmentRef as string, 'utf8'),
    '%PDF-1.7\n%fixture\n',
  );
  assert.equal(
    await readFile(files[3]?.attachmentRef as string, 'utf8'),
    'PK zipped epub fixture',
  );
  // The same package yields the same bytes, so a rerun keeps the same copy.
  assert.deepEqual(
    again,
    files.map(({ attachmentRef }) => ({ attachmentRef })),
  );
});

test('Books follows each store on its own: a rerun writes nothing, and edits, deletions and changed book files land', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  await using warehouse = await appleWarehouse(
    'books',
    new AppleBooksSource(location),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;
  const loads = async () =>
    rows(
      await warehouse.sql`SELECT (SELECT count(DISTINCT loaded_at) FROM apple_books.raw_annotations)::int AS annotations,
        (SELECT count(DISTINCT loaded_at) FROM apple_books."raw_libraryAssets")::int AS assets,
        (SELECT count(DISTINCT loaded_at) FROM apple_books."raw_bookFiles")::int AS files`,
    );
  await warehouse.load();
  const first = await loads();
  const epubBefore = (
    await agent`SELECT "attachmentRef" FROM books_book_files WHERE "assetId" = 'A1'`
  )[0]?.attachmentRef;

  await warehouse.load();
  const unchanged = await loads();
  {
    using store = new DatabaseSync(location.files.annotations);
    store.exec("DELETE FROM ZAEANNOTATION WHERE ZANNOTATIONUUID = 'U-2'");
    store.exec(
      "UPDATE ZAEANNOTATION SET ZANNOTATIONNOTE = 'Rhythm first' WHERE ZANNOTATIONUUID = 'H-1'",
    );
  }
  {
    using store = new DatabaseSync(location.files.readingHistory);
    store.prepare('UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = ?').run(
      readingHistoryDocument(
        [
          ...defaultHistory.months.slice(0, 1),
          {
            key: 202609,
            lastDayStreakOrdinal: -1,
            days: [{ day: 8, reading: [[0, 1400]], goal: 1800 }],
          },
        ],
        defaultHistory.streaks,
      ),
    );
  }
  await writeFile(
    join(location.documents, 'Design.epub/OEBPS/chapter.xhtml'),
    '<html>Grids, rhythm and type</html>',
  );
  await warehouse.load();

  assert.deepEqual(first, [{ annotations: 1, assets: 1, files: 1 }]);
  assert.deepEqual(unchanged, first);
  assert.deepEqual(
    rows(await agent`SELECT id, note FROM books_annotations ORDER BY id`),
    [
      { id: 'D-4', note: null },
      { id: 'H-1', note: 'Rhythm first' },
      { id: 'R-3', note: null },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT date::text, "readingSeconds"::int AS seconds FROM books_reading_days ORDER BY date`,
    ),
    [{ date: '2026-09-08', seconds: 1400 }],
  );
  // Only the changed book file is written again; the library is untouched.
  assert.deepEqual(await loads(), [{ annotations: 2, assets: 1, files: 2 }]);
  const epubAfter = (
    await agent`SELECT "attachmentRef" FROM books_book_files WHERE "assetId" = 'A1'`
  )[0]?.attachmentRef;
  assert.notEqual(epubAfter, epubBefore);
  assert.match(
    (await run('/usr/bin/unzip', ['-p', epubAfter, 'OEBPS/chapter.xhtml']))
      .stdout,
    /Grids, rhythm and type/,
  );
});

test('Books names Full Disk Access for an unreadable store, refuses an unknown layout or reading history format, and keeps the rows it had', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const source = new AppleBooksSource(location);
  await using warehouse = await appleWarehouse(
    'books',
    source,
    join(scratch.path, 'outputs'),
  );
  await warehouse.load();
  await rm(location.files.appPreferences);
  {
    using store = new DatabaseSync(location.files.assetData);
    store.exec('ALTER TABLE ZBCASSETDETAIL DROP COLUMN ZREADINGPROGRESS');
  }
  {
    using store = new DatabaseSync(location.files.readingHistory);
    store
      .prepare('UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = ?')
      .run(
        readingHistoryDocument(
          defaultHistory.months,
          defaultHistory.streaks,
          6,
        ),
      );
  }

  const failure = await warehouse.load().then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof PipelineError);
  const failed = Object.fromEntries(
    failure.results
      .filter(({ failures }) => failures.length > 0)
      .map(({ copy, failures }) => [
        copy.configuration.stream.name,
        String(failures[0]?.error),
      ]),
  );
  // Each store fails only its own streams.
  assert.deepEqual(Object.keys(failed).sort(), [
    'assetDetails',
    'readingDays',
    'readingGoal',
    'readingMonths',
    'reviews',
    'streakRecords',
  ]);
  assert.match(
    failed.readingGoal ?? '',
    /com\.apple\.iBooksX\.plist cannot be read\. Open Books once so it creates its stores; if they exist, allow the process that runs the export Full Disk Access/,
  );
  assert.match(
    failed.assetDetails ?? '',
    /missing ZBCASSETDETAIL\.ZREADINGPROGRESS/,
  );
  assert.match(
    failed.readingDays ?? '',
    /missing reading history format version 6/,
  );
  assert.deepEqual(
    rows(
      await warehouse.agent`SELECT (SELECT count(*) FROM books_asset_details)::int AS details,
        (SELECT count(*) FROM books_reading_days)::int AS days,
        (SELECT count(*) FROM books_reading_goal)::int AS goal,
        (SELECT count(*) FROM books_annotations)::int AS annotations`,
    ),
    [{ details: 2, days: 2, goal: 1, annotations: 4 }],
  );
  const messages = await Array.fromAsync(
    source.read(
      [
        new Copy(
          source.readingGoal,
          new SQLiteDestination({
            path: join(scratch.path, 'goal.sqlite'),
          }).table('goal'),
        ).configuration,
      ],
      new Map(),
    ),
  );
  const status = messages.find(
    (message) => message instanceof StreamStatus && message.status === 'FAILED',
  );
  assert.ok(status instanceof StreamStatus);
  assert.ok(status.error instanceof BooksUnavailableError);
  const history = await Array.fromAsync(
    source.read(
      [
        new Copy(
          source.readingMonths,
          new SQLiteDestination({
            path: join(scratch.path, 'months.sqlite'),
          }).table('months'),
        ).configuration,
      ],
      new Map(),
    ),
  );
  const historyStatus = history.find(
    (message) => message instanceof StreamStatus && message.status === 'FAILED',
  );
  assert.ok(historyStatus instanceof StreamStatus);
  assert.ok(historyStatus.error instanceof BooksSchemaError);
});

test('a Books watch wakes only the streams of the store that changed, while Books keeps its databases open', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const source = new AppleBooksSource({ ...location, pollIntervalMs: 20 });
  const streams = [
    source.libraryAssets,
    source.annotations,
    source.assetDetails,
    source.readingGoal,
  ];
  // Books and bookdatastored hold their connections, and so their WALs, open.
  using annotations = new DatabaseSync(location.files.annotations);
  using assetData = new DatabaseSync(location.files.assetData);
  const controller = new AbortController();
  const woken: string[][] = [];

  for await (const batch of source.watch({
    streams,
    signal: controller.signal,
  })) {
    woken.push(batch.map((stream) => stream.name));
    if (woken.length === 1)
      annotations.exec(
        "UPDATE ZAEANNOTATION SET ZANNOTATIONNOTE = 'Watched' WHERE ZANNOTATIONUUID = 'H-1'",
      );
    else if (woken.length === 2)
      await writePlist(location.files.appPreferences, {
        'ReadingGoals.StreakDay': { goal: 600 },
        'ReadingHistory.CurrentStreak': 1,
      });
    else if (woken.length === 3)
      assetData.exec(
        "UPDATE ZBCASSETDETAIL SET ZREADINGPROGRESS = 0.6 WHERE ZASSETID = 'A1'",
      );
    else controller.abort();
  }

  assert.deepEqual(woken, [
    ['libraryAssets', 'annotations', 'assetDetails', 'readingGoal'],
    ['annotations'],
    ['readingGoal'],
    ['assetDetails'],
  ]);
});

test('Books reads this Mac’s stores into SQLite without opening iCloud placeholders', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Books requires macOS');
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-live-'));
  const source = new AppleBooksSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'books.sqlite'),
  });
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  const { streams } = await source.discover();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'live',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(
              stream,
              destination.table(
                stream.name,
                stream.supportsFileTransfer
                  ? (columns) => [
                      ...SQLiteColumns.fromSchema(stream.jsonSchema),
                      columns
                        .text('attachmentRef')
                        .from(stream.file.store(files)),
                    ]
                  : undefined,
              ),
              {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
      }),
    ],
  });

  const outcome = await pipeline.run().then(
    (results) => results,
    (error: unknown) => error,
  );
  if (
    outcome instanceof PipelineError &&
    JSON.stringify(outcome, Object.getOwnPropertyNames(outcome)).includes(
      BooksUnavailableError.name,
    )
  )
    return t.skip(`no access to ${booksContainer} or ${booksGroupContainer}`);
  assert.ok(Array.isArray(outcome), String(outcome));

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const count = (sql: string) => Number(database.prepare(sql).get()?.n);
  // Every stored book has its bytes on this Mac; a placeholder has none.
  assert.equal(
    count(
      'SELECT count(*) AS n FROM bookFiles WHERE availableLocally <> (attachmentRef IS NOT NULL)',
    ),
    0,
  );
  assert.equal(
    count('SELECT count(*) AS n FROM bookFiles'),
    count('SELECT count(*) AS n FROM libraryAssets WHERE path IS NOT NULL'),
  );
});
