import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Connection,
  Copy,
  type CopyResult,
  Pipeline,
  PipelineError,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  DiaArchiveFormatError,
  DiaArchiveMissingError,
  diaArchivePath,
} from '@workspace/sdk-dia-desktop';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { DiaDesktopSource } from './dia-desktop-source.ts';

// Seconds since 2001-01-01 UTC, as Dia writes archiveDate.
const october1 = 812_538_000.123456; // 2026-10-01T09:00:00.123456Z
const october2 = october1 + 86_400; // 2026-10-02T09:00:00.123456Z
const october3 = october2 + 86_400; // 2026-10-03T09:00:00.123456Z

const space = '5A000000-0000-4000-8000-000000000001';
const group = '6B000000-0000-4000-8000-000000000001';
const page = {
  id: '1A000000-0000-4000-8000-000000000001',
  title: 'Example page',
  variant: { webContent: { _0: 'https://example.com/page' } },
  archiveDate: october1,
  spaceID: space,
  url: 'https://example.com/page',
  groupID: group,
};
// A supertab has no url, and its variant holds two UUIDs Dia does not name.
const supertab = {
  id: '1A000000-0000-4000-8000-000000000002',
  title: 'New Tab',
  variant: {
    supertab: {
      _0: '7C000000-0000-4000-8000-000000000001',
      _1: { newTab: {} },
      _2: '7C000000-0000-4000-8000-000000000002',
    },
  },
  archiveDate: october2,
  spaceID: space,
};
const other = {
  id: '1A000000-0000-4000-8000-000000000003',
  title: 'Other page',
  variant: { webContent: { _0: 'https://example.org/' } },
  archiveDate: october3,
  spaceID: space,
  url: 'https://example.org/',
};

type Tab = Record<string, unknown>;

// Writes the archive as Dia does: the whole file, replaced by a rename.
async function writeArchive(
  home: string,
  profiles: Record<string, readonly Tab[]>,
  document: (containers: unknown[]) => unknown = (containers) => ({
    version: 2,
    containers,
  }),
) {
  const path = diaArchivePath(home);
  await mkdir(dirname(path), { recursive: true });
  const containers = Object.entries(profiles).map(([profile, tabs]) => ({
    id: { profile: { _0: profile } },
    archivedTabs: tabs,
  }));
  await writeFile(`${path}.draft`, JSON.stringify(document(containers)));
  await rename(`${path}.draft`, path);
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

async function pipeline(source: DiaDesktopSource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const { streams } = await source.discover();
  return new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

function failureTypes(error: {
  readonly results: readonly {
    readonly failures: readonly { readonly failureType: string }[];
  }[];
}): string[] {
  return [
    ...new Set(
      error.results.flatMap(({ failures }) =>
        failures.map(({ failureType }) => failureType),
      ),
    ),
  ];
}

const ids = (out: string) =>
  rows(
    out,
    'SELECT profileId, id FROM archivedTabs ORDER BY profileId, id',
  ).map(({ profileId, id }) => `${profileId}/${id}`);

const unchanged = { archivedTabs: { count: 0, deleted: 0 } };

test('an archive in a format Dia did not write before fails the pass, names where it is wrong, and keeps what loaded', async () => {
  await using dir = await new TemporaryFiles().directory('elt-dia-');
  await writeArchive(dir.path, { 'Profile 1': [page] });
  const run = await pipeline(
    new DiaDesktopSource({ home: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();

  const broken: [
    string,
    Record<string, readonly Tab[]>,
    ((containers: unknown[]) => unknown) | undefined,
    RegExp,
  ][] = [
    [
      'a new version',
      { 'Profile 1': [page] },
      (containers) => ({ version: 3, containers }),
      /version is 3, not 2/,
    ],
    [
      'a date that is not a number',
      { 'Profile 1': [page, { ...other, archiveDate: '2026-10-03' }] },
      undefined,
      /containers\[0\]\.archivedTabs\[1\]\.archiveDate is not a number/,
    ],
    [
      'a variant with two cases',
      {
        'Profile 1': [
          { ...page, variant: { ...page.variant, ...supertab.variant } },
        ],
      },
      undefined,
      /containers\[0\]\.archivedTabs\[0\]\.variant has 2 cases, not 1/,
    ],
    [
      'a container that is not a profile',
      { 'Profile 1': [page] },
      () => ({ version: 2, containers: [{ id: {}, archivedTabs: [] }] }),
      /containers\[0\]\.id\.profile is not an object/,
    ],
  ];
  for (const [label, profiles, document, message] of broken) {
    await writeArchive(dir.path, profiles, document);
    await assert.rejects(
      run.run(),
      (error) => {
        assert.ok(error instanceof PipelineError, label);
        const [cause] = error.errors;
        assert.ok(cause instanceof DiaArchiveFormatError, label);
        assert.match(cause.message, message, label);
        assert.deepEqual(failureTypes(error), ['system'], label);
        return true;
      },
      label,
    );
  }
  // A read in the middle of a write that is not a rename sees part of it.
  await writeFile(diaArchivePath(dir.path), '{"version":2,"contain');
  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    const [cause] = error.errors;
    assert.ok(cause instanceof DiaArchiveFormatError);
    assert.match(cause.message, /the file is not JSON/);
    return true;
  });

  assert.deepEqual(ids(out), [`Profile 1/${page.id}`]);
});

test('a home without Dia’s archive fails as the user’s to fix and keeps what loaded', async () => {
  await using dir = await new TemporaryFiles().directory('elt-dia-');
  const run = await pipeline(
    new DiaDesktopSource({ home: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  const missing = (error: unknown) => {
    assert.ok(error instanceof PipelineError);
    assert.ok(error.errors.length > 0);
    for (const cause of error.errors)
      assert.ok(cause instanceof DiaArchiveMissingError);
    assert.deepEqual(failureTypes(error), ['config']);
    return true;
  };

  await assert.rejects(run.run(), missing);
  await writeArchive(dir.path, { 'Profile 1': [page] });
  await run.run();
  await rm(diaArchivePath(dir.path));
  await assert.rejects(run.run(), missing);

  assert.deepEqual(ids(out), [`Profile 1/${page.id}`]);
});

test('each archived tab loads every field Dia keeps, under its profile', async () => {
  await using dir = await new TemporaryFiles().directory('elt-dia-');
  // One tab id in two profiles is two tabs.
  await writeArchive(dir.path, {
    'Profile 1': [page, supertab],
    Default: [{ ...page, title: 'Same tab id, other profile' }],
  });
  const out = join(dir.path, 'out.sqlite');

  const results = await (
    await pipeline(new DiaDesktopSource({ home: dir.path }), dir.path)
  ).run();

  assert.deepEqual(counts(results), {
    archivedTabs: { count: 3, deleted: 0 },
  });
  assert.deepEqual(
    rows(
      out,
      'SELECT profileId, id, title, kind, url, archivedAt, spaceId, groupId, variant FROM archivedTabs ORDER BY profileId, id',
    ),
    [
      {
        profileId: 'Default',
        id: page.id,
        title: 'Same tab id, other profile',
        kind: 'webContent',
        url: 'https://example.com/page',
        archivedAt: '2026-10-01T09:00:00.123456Z',
        spaceId: space,
        groupId: group,
        variant: '{"webContent":{"_0":"https://example.com/page"}}',
      },
      {
        profileId: 'Profile 1',
        id: page.id,
        title: 'Example page',
        kind: 'webContent',
        url: 'https://example.com/page',
        archivedAt: '2026-10-01T09:00:00.123456Z',
        spaceId: space,
        groupId: group,
        variant: '{"webContent":{"_0":"https://example.com/page"}}',
      },
      {
        profileId: 'Profile 1',
        id: supertab.id,
        title: 'New Tab',
        kind: 'supertab',
        url: null,
        archivedAt: '2026-10-02T09:00:00.123456Z',
        spaceId: space,
        groupId: null,
        variant:
          '{"supertab":{"_0":"7C000000-0000-4000-8000-000000000001","_1":{"newTab":{}},"_2":"7C000000-0000-4000-8000-000000000002"}}',
      },
    ],
  );
});

test('a tab Dia removes from its archive stays loaded, and an unchanged archive writes nothing', async () => {
  await using dir = await new TemporaryFiles().directory('elt-dia-');
  await writeArchive(dir.path, { 'Profile 1': [page, supertab, other] });
  const run = await pipeline(
    new DiaDesktopSource({ home: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();

  await writeArchive(dir.path, { 'Profile 1': [page, other] });
  const removed = counts(await run.run());
  const again = counts(await run.run());

  assert.deepEqual(removed, unchanged);
  assert.deepEqual(again, unchanged);
  assert.deepEqual(ids(out), [
    `Profile 1/${page.id}`,
    `Profile 1/${supertab.id}`,
    `Profile 1/${other.id}`,
  ]);
});

test('a rewrite that orders keys differently writes nothing, and an edited tab is written again', async () => {
  await using dir = await new TemporaryFiles().directory('elt-dia-');
  await writeArchive(dir.path, { 'Profile 1': [page, supertab] });
  const run = await pipeline(
    new DiaDesktopSource({ home: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  // Dia writes a supertab's variant keys in a new order from one write to the
  // next.
  const reordered = {
    variant: {
      supertab: {
        _2: supertab.variant.supertab._2,
        _1: { newTab: {} },
        _0: supertab.variant.supertab._0,
      },
    },
    spaceID: supertab.spaceID,
    archiveDate: supertab.archiveDate,
    title: supertab.title,
    id: supertab.id,
  };

  await writeArchive(dir.path, { 'Profile 1': [page, reordered] });
  const reorderedRun = counts(await run.run());
  await writeArchive(dir.path, {
    'Profile 1': [{ ...page, title: 'Renamed page' }, reordered],
  });
  const editedRun = counts(await run.run());

  assert.deepEqual(reorderedRun, unchanged);
  assert.deepEqual(editedRun, { archivedTabs: { count: 1, deleted: 0 } });
  assert.deepEqual(
    rows(out, 'SELECT title FROM archivedTabs ORDER BY id').map(
      ({ title }) => title,
    ),
    ['Renamed page', 'New Tab'],
  );
});

test('an import scope keeps the tabs of the selected profiles archived within its dates', async () => {
  const cases: [ImportScope, string[]][] = [
    [{ collectionIds: ['Default'] }, [`Default/${other.id}`]],
    [
      {
        startAt: '2026-10-01T09:00:00.124Z',
        endAt: '2026-10-03T09:00:00.123Z',
      },
      [`Profile 1/${supertab.id}`],
    ],
    [
      { collectionIds: ['Profile 1'], startAt: '2026-10-01T09:00:00.123Z' },
      [`Profile 1/${page.id}`, `Profile 1/${supertab.id}`],
    ],
  ];
  for (const [scope, expected] of cases) {
    await using dir = await new TemporaryFiles().directory('elt-dia-');
    await writeArchive(dir.path, {
      'Profile 1': [page, supertab],
      Default: [other],
    });

    await (
      await pipeline(new DiaDesktopSource({ home: dir.path, scope }), dir.path)
    ).run();

    assert.deepEqual(
      ids(join(dir.path, 'out.sqlite')),
      expected,
      JSON.stringify(scope),
    );
  }
});

test('a pass is current as of Dia’s last write of its archive', async () => {
  await using dir = await new TemporaryFiles().directory('elt-dia-');
  await writeArchive(dir.path, { 'Profile 1': [page] });
  // Dia quit after this write; a reader read the file later.
  const written = new Date('2026-10-20T20:43:59.000Z');
  await utimes(diaArchivePath(dir.path), new Date(), written);

  await (
    await pipeline(new DiaDesktopSource({ home: dir.path }), dir.path)
  ).run();

  assert.deepEqual(
    rows(
      join(dir.path, 'out.sqlite'),
      'SELECT current_as_of FROM stream_status',
    ).map(({ current_as_of }) => current_as_of),
    [written.toISOString()],
  );
});

test('a watch loads each write of the archive and nothing between writes', async () => {
  await using dir = await new TemporaryFiles().directory('elt-dia-');
  await writeArchive(dir.path, { 'Profile 1': [page] });
  const run = await pipeline(
    new DiaDesktopSource({ home: dir.path }),
    dir.path,
  );
  const controller = new AbortController();
  const batches: Record<string, { count: number; deleted: number }>[] = [];

  for await (const { outcomes } of run.watch({
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(counts(outcomes));
    if (batches.length === 1)
      await writeArchive(dir.path, { 'Profile 1': [page, supertab] });
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
  }

  assert.deepEqual(batches, [
    { archivedTabs: { count: 1, deleted: 0 } },
    { archivedTabs: { count: 1, deleted: 0 } },
  ]);
});

test('this Mac’s Dia archive loads every archived tab, and a second read writes nothing', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Dia runs on macOS');
  await using dir = await new TemporaryFiles().directory('elt-dia-live-');
  const out = join(dir.path, 'out.sqlite');
  const run = await pipeline(
    new DiaDesktopSource({ home: homedir() }),
    dir.path,
  );

  let first: ReturnType<typeof counts>;
  try {
    first = counts(await run.run());
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every((cause) => cause instanceof DiaArchiveMissingError)
    )
      return t.skip('Dia keeps no archive on this Mac');
    throw error;
  }

  // Counted, never printed: these are the user's own tabs. Dia may archive a
  // tab between the two reads, so the second read is at most that tab.
  const loaded = (sql: string) => Number(rows(out, sql)[0]?.n);
  assert.ok(first.archivedTabs && first.archivedTabs.count > 0);
  assert.equal(first.archivedTabs.deleted, 0);
  assert.equal(
    loaded(
      "SELECT count(*) AS n FROM archivedTabs WHERE kind NOT IN ('webContent', 'supertab') OR (kind = 'webContent') <> (url IS NOT NULL) OR json_extract(variant, '$.webContent._0') IS NOT url",
    ),
    0,
  );
  // Each profile loads as many tabs as the file lists for it, read here
  // apart from the SDK.
  const file: {
    containers: { id: { profile: { _0: string } }; archivedTabs: unknown[] }[];
  } = JSON.parse(await readFile(diaArchivePath(homedir()), 'utf8'));
  const listed = new Map<string, number>();
  for (const { id, archivedTabs } of file.containers)
    if (archivedTabs.length > 0)
      listed.set(
        id.profile._0,
        (listed.get(id.profile._0) ?? 0) + archivedTabs.length,
      );
  assert.deepEqual(
    new Map(
      rows(
        out,
        'SELECT profileId, count(*) AS n FROM archivedTabs GROUP BY profileId',
      ).map(({ profileId, n }) => [String(profileId), Number(n)]),
    ),
    listed,
  );
  // Dates fall between Dia's first release and now; ids are UUIDs.
  const uuid = '[0-9A-F]'.repeat(8) + '-' + '[0-9A-F]'.repeat(4);
  assert.equal(
    loaded(
      `SELECT count(*) AS n FROM archivedTabs WHERE archivedAt NOT BETWEEN '2024-01-01' AND '${new Date(Date.now() + 86_400_000).toISOString()}' OR id NOT GLOB '${uuid}*' OR spaceId NOT GLOB '${uuid}*' OR (groupId IS NOT NULL AND groupId NOT GLOB '${uuid}*')`,
    ),
    0,
  );
  assert.ok((counts(await run.run()).archivedTabs?.count ?? 0) <= 1);
});
