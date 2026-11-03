import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';
import { timebox } from '@zukhruf/testing/async';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Connection,
  Copy,
  Pipeline,
  type PipelineClock,
  PipelineError,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { ArcDesktopSource } from './arc-desktop-source.ts';

type Item = {
  id: string;
  parentID: string | null;
  childrenIds: string[];
  title: string | null;
  createdAt: number;
  isUnread: boolean;
  originatingDevice: string;
  data: Record<string, unknown>;
};

const device = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD';
const secondProfile = {
  custom: {
    _0: {
      directoryBasename: 'Profile 2',
      machineID: 'MMMMMMMM-MMMM-4MMM-8MMM-MMMMMMMMMMMM',
    },
  },
};

function item(
  id: string,
  parentID: string | null,
  data: Record<string, unknown>,
  childrenIds: string[] = [],
  title: string | null = null,
): Item {
  return {
    id,
    parentID,
    childrenIds,
    title,
    createdAt: 800000000.5,
    isUnread: false,
    originatingDevice: device,
    data,
  };
}

function tab(id: string, parent: string, url: string): Item {
  return item(id, parent, {
    tab: {
      savedTitle: `Page ${id}`,
      savedURL: url,
      savedMuteStatus: 'allowAudio',
      timeLastActiveAt: 800000100.25,
    },
  });
}

// A sidebar as Arc writes it: one default-profile space (Home) and one
// space of Profile 2 (Side), each with a pinned and an unpinned container,
// and the favorites of each profile. Swift writes each dictionary as its
// keys and values in turn.
function sidebar() {
  const items: Item[] = [
    item(
      'home-pinned',
      null,
      {
        itemContainer: { containerType: { spaceItems: { _0: 'home' } } },
      },
      ['folder-work', 'note-plan'],
    ),
    item(
      'folder-work',
      'home-pinned',
      { list: {} },
      ['tab-docs', 'split-pair'],
      'Work',
    ),
    {
      ...tab('tab-docs', 'folder-work', 'https://example.com/docs'),
      title: 'Docs',
      data: {
        tab: {
          savedTitle: 'Example docs',
          savedURL: 'https://example.com/docs',
          savedMuteStatus: 'allowAudio',
          timeLastActiveAt: 800000100.25,
          referrerID: 'tab-news',
          activeTabBeforeCreationID: 'tab-mail',
        },
      },
    },
    item(
      'split-pair',
      'folder-work',
      {
        splitView: {
          itemWidthFactors: ['tab-left', 0.5],
          timeLastActiveAt: 800000200,
          focusItemID: null,
          customInfo: null,
          layoutOrientation: 'horizontal',
        },
      },
      ['tab-left', 'tab-right'],
    ),
    {
      ...tab('tab-left', 'split-pair', 'https://example.com/left'),
      isUnread: true,
      data: {
        tab: {
          savedTitle: 'Page tab-left',
          savedURL: 'https://example.com/left',
          savedMuteStatus: 'muted',
          timeLastActiveAt: 800000100.25,
        },
      },
    },
    // Arc saved no page title and no last use for this tab.
    item('tab-right', 'split-pair', {
      tab: {
        savedURL: 'https://example.com/right',
        savedMuteStatus: 'allowAudio',
      },
    }),
    item(
      'note-plan',
      'home-pinned',
      {
        arcDocument: {
          isEditable: true,
          timeLastActiveAt: 790000000.123456,
          arcDocumentID: 'NNNNNNNN-NNNN-4NNN-8NNN-NNNNNNNNNNNN',
        },
      },
      [],
      'Plan',
    ),
    item(
      'home-unpinned',
      null,
      {
        itemContainer: { containerType: { spaceItems: { _0: 'home' } } },
      },
      ['tab-news'],
    ),
    tab('tab-news', 'home-unpinned', 'https://example.com/news'),
    item(
      'side-pinned',
      null,
      {
        itemContainer: { containerType: { spaceItems: { _0: 'side' } } },
      },
      ['folder-side'],
    ),
    item('folder-side', 'side-pinned', { list: {} }, ['tab-side'], 'Reading'),
    tab('tab-side', 'folder-side', 'https://example.com/side'),
    item('side-unpinned', null, {
      itemContainer: { containerType: { spaceItems: { _0: 'side' } } },
    }),
    item(
      'favorites-default',
      null,
      {
        itemContainer: { containerType: { topApps: { _0: { default: {} } } } },
      },
      ['tab-mail'],
    ),
    tab('tab-mail', 'favorites-default', 'https://example.com/mail'),
    item(
      'favorites-second',
      null,
      {
        itemContainer: { containerType: { topApps: { _0: secondProfile } } },
      },
      ['tab-chat'],
    ),
    tab('tab-chat', 'favorites-second', 'https://example.com/chat'),
  ];
  const spaces = [
    {
      id: 'home',
      title: 'Home',
      profile: { default: {} },
      containerIDs: ['pinned', 'home-pinned', 'unpinned', 'home-unpinned'],
      newContainerIDs: [
        { unpinned: { _0: { shared: {} } } },
        'home-unpinned',
        { pinned: {} },
        'home-pinned',
      ],
      customInfo: {
        iconType: { emoji: 127968, emoji_v2: '🏠' },
        windowTheme: { background: { single: { _0: { style: 'color' } } } },
      },
    },
    {
      id: 'side',
      title: 'Side',
      profile: secondProfile,
      containerIDs: ['pinned', 'side-pinned', 'unpinned', 'side-unpinned'],
      newContainerIDs: [],
      customInfo: { windowTheme: {} },
    },
  ];
  return { items, spaces };
}

async function writeSidebar(
  home: string,
  { items, spaces }: ReturnType<typeof sidebar>,
) {
  const directory = join(home, 'Library/Application Support/Arc');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'StorableSidebar.json');
  await writeFile(
    file,
    JSON.stringify({
      sidebarSyncState: {},
      firebaseSyncState: {},
      version: 1,
      sidebar: {
        containers: [
          { global: {} },
          {
            topAppsContainerIDs: [
              { default: {} },
              'favorites-default',
              secondProfile,
              'favorites-second',
            ],
            items: items.flatMap((entry) => [entry.id, entry]),
            spaces: spaces.flatMap((entry) => [entry.id, entry]),
          },
        ],
      },
    }),
  );
  return file;
}

async function arcImport(
  home: string,
  directory: string,
  clock: PipelineClock,
  scope?: ImportScope,
) {
  const source = new ArcDesktopSource({ home, scope });
  const out = join(directory, 'out.sqlite');
  const destination = new SQLiteDestination({ path: out });
  const { streams } = await source.discover();
  const pipeline = new Pipeline({
    clock,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'arc',
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
  const read = (sql: string) => {
    using db = new DatabaseSync(out, { readOnly: true });
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  };
  const written = async () =>
    Object.fromEntries(
      (await pipeline.run()).map(({ copy, count, deleted }) => [
        copy.from.name,
        { count, deleted },
      ]),
    );
  return { source, pipeline, read, written };
}

const tree =
  'select id, profileId, spaceId, section, parentId, position, kind from sidebarItems order by id';

test('a denied or missing sidebar fails every stream as a config failure and keeps the loaded rows', async () => {
  await using dir = await new TemporaryFiles().directory('arc-missing-');
  const file = await writeSidebar(dir.path, sidebar());
  const { source, pipeline, read } = await arcImport(
    dir.path,
    dir.path,
    globalThis,
  );
  await pipeline.run();

  for (const take of [() => chmod(file, 0o000), () => rm(file)]) {
    await take();
    const failure = await pipeline.run().then(
      () => assert.fail('the run succeeded without the file'),
      (error: unknown) => error,
    );

    assert.ok(failure instanceof PipelineError);
    assert.equal(failure.errors.length, 2);
    for (const error of failure.errors) {
      assert.equal(source.failureType(error), 'config');
      assert.match(String(error), /StorableSidebar\.json.*cannot be read/);
    }
    assert.equal(read('select count(*) n from sidebarItems')[0]?.n, 11);
    assert.equal(read('select count(*) n from spaces')[0]?.n, 2);
  }
});

test('a malformed sidebar fails with what is wrong and deletes nothing', async () => {
  await using dir = await new TemporaryFiles().directory('arc-format-');
  const file = await writeSidebar(dir.path, sidebar());
  const { source, pipeline, read } = await arcImport(
    dir.path,
    dir.path,
    globalThis,
  );
  await pipeline.run();
  const unknownKind = sidebar();
  unknownKind.items.push(item('easel-1', 'home-unpinned', { easel: {} }));
  unknownKind.items
    .find(({ id }) => id === 'home-unpinned')
    ?.childrenIds.push('easel-1');
  const stray = sidebar();
  stray.items.push(tab('tab-stray', 'nowhere', 'https://example.com/stray'));

  for (const [write, reason] of [
    [() => writeFile(file, '{"version":1,'), /is not JSON/],
    [() => writeSidebar(dir.path, unknownKind), /easel-1 is of the kind easel/],
    [() => writeSidebar(dir.path, stray), /tab-stray is in no space/],
  ] as const) {
    await write();
    const failure = await pipeline.run().then(
      () => assert.fail('the run succeeded over a malformed file'),
      (error: unknown) => error,
    );
    assert.ok(failure instanceof PipelineError);
    for (const error of failure.errors) {
      assert.match(String(error), reason);
      assert.equal(source.failureType(error), 'system');
    }
    assert.equal(read('select count(*) n from sidebarItems')[0]?.n, 11);
  }
});

test('an Arc import loads the spaces and every item with its place in the tree', async () => {
  await using dir = await new TemporaryFiles().directory('arc-load-');
  await writeSidebar(dir.path, sidebar());
  const { read, source, written } = await arcImport(
    dir.path,
    dir.path,
    globalThis,
  );

  assert.equal(source.identity, 'arc-desktop');
  assert.deepEqual(await written(), {
    spaces: { count: 2, deleted: 0 },
    sidebarItems: { count: 11, deleted: 0 },
  });

  assert.deepEqual(
    read(
      'select id, position, title, profileId, profileMachineId, emoji, customInfo from spaces order by position',
    ),
    [
      {
        id: 'home',
        position: 0,
        title: 'Home',
        profileId: 'Default',
        profileMachineId: null,
        emoji: '🏠',
        customInfo: JSON.stringify(sidebar().spaces[0]?.customInfo),
      },
      {
        id: 'side',
        position: 1,
        title: 'Side',
        profileId: 'Profile 2',
        profileMachineId: 'MMMMMMMM-MMMM-4MMM-8MMM-MMMMMMMMMMMM',
        emoji: null,
        customInfo: '{"windowTheme":{}}',
      },
    ],
  );
  const place = (
    id: string,
    profileId: string,
    spaceId: string | null,
    section: string,
    parentId: string | null,
    position: number,
    kind: string,
  ) => ({ id, profileId, spaceId, section, parentId, position, kind });
  assert.deepEqual(read(tree), [
    place('folder-side', 'Profile 2', 'side', 'pinned', null, 0, 'folder'),
    place('folder-work', 'Default', 'home', 'pinned', null, 0, 'folder'),
    place('note-plan', 'Default', 'home', 'pinned', null, 1, 'note'),
    place(
      'split-pair',
      'Default',
      'home',
      'pinned',
      'folder-work',
      1,
      'splitView',
    ),
    place('tab-chat', 'Profile 2', null, 'favorites', null, 0, 'tab'),
    place('tab-docs', 'Default', 'home', 'pinned', 'folder-work', 0, 'tab'),
    place('tab-left', 'Default', 'home', 'pinned', 'split-pair', 0, 'tab'),
    place('tab-mail', 'Default', null, 'favorites', null, 0, 'tab'),
    place('tab-news', 'Default', 'home', 'unpinned', null, 0, 'tab'),
    place('tab-right', 'Default', 'home', 'pinned', 'split-pair', 1, 'tab'),
    place('tab-side', 'Profile 2', 'side', 'pinned', 'folder-side', 0, 'tab'),
  ]);
  const common = {
    createdAt: '2026-05-09T06:13:20.500000Z',
    unread: 0,
    originatingDeviceId: device,
  };
  const none = {
    url: null,
    savedTitle: null,
    muteStatus: null,
    lastActiveAt: null,
    referrerId: null,
    openerId: null,
    documentId: null,
    editable: null,
    layoutOrientation: null,
    focusItemId: null,
    customInfo: null,
  };
  const details = (id: string) =>
    read(
      `select id, kind, title, createdAt, unread, originatingDeviceId, widthFactor, url, savedTitle, muteStatus, lastActiveAt, referrerId, openerId, documentId, editable, layoutOrientation, focusItemId, customInfo from sidebarItems where id = '${id}'`,
    )[0];
  assert.deepEqual(details('tab-docs'), {
    id: 'tab-docs',
    kind: 'tab',
    title: 'Docs',
    ...common,
    widthFactor: null,
    ...none,
    url: 'https://example.com/docs',
    savedTitle: 'Example docs',
    muteStatus: 'allowAudio',
    lastActiveAt: '2026-05-09T06:15:00.250000Z',
    referrerId: 'tab-news',
    openerId: 'tab-mail',
  });
  assert.deepEqual(details('tab-left'), {
    id: 'tab-left',
    kind: 'tab',
    title: null,
    ...common,
    unread: 1,
    widthFactor: 0.5,
    ...none,
    url: 'https://example.com/left',
    savedTitle: 'Page tab-left',
    muteStatus: 'muted',
    lastActiveAt: '2026-05-09T06:15:00.250000Z',
  });
  assert.deepEqual(details('tab-right'), {
    id: 'tab-right',
    kind: 'tab',
    title: null,
    ...common,
    widthFactor: null,
    ...none,
    url: 'https://example.com/right',
    muteStatus: 'allowAudio',
  });
  assert.deepEqual(details('folder-work'), {
    id: 'folder-work',
    kind: 'folder',
    title: 'Work',
    ...common,
    widthFactor: null,
    ...none,
  });
  assert.deepEqual(details('note-plan'), {
    id: 'note-plan',
    kind: 'note',
    title: 'Plan',
    ...common,
    widthFactor: null,
    ...none,
    documentId: 'NNNNNNNN-NNNN-4NNN-8NNN-NNNNNNNNNNNN',
    editable: 1,
    lastActiveAt: '2026-01-13T12:26:40.123456Z',
  });
  assert.deepEqual(details('split-pair'), {
    id: 'split-pair',
    kind: 'splitView',
    title: null,
    ...common,
    widthFactor: null,
    ...none,
    layoutOrientation: 'horizontal',
    lastActiveAt: '2026-05-09T06:16:40.000000Z',
  });
  assert.deepEqual(
    read(
      "select id, widthFactor from sidebarItems where parentId = 'split-pair' order by id",
    ),
    [
      { id: 'tab-left', widthFactor: 0.5 },
      { id: 'tab-right', widthFactor: null },
    ],
  );
});

test('a rerun writes nothing, and edits, moves and removals reach the rows', async () => {
  await using dir = await new TemporaryFiles().directory('arc-edit-');
  await writeSidebar(dir.path, sidebar());
  const { read, written } = await arcImport(dir.path, dir.path, globalThis);
  await written();

  const unchanged = await written();
  const edited = sidebar();
  const byId = (id: string) => {
    const found = edited.items.find((entry) => entry.id === id);
    assert.ok(found);
    return found;
  };
  // Rename the space, move tab-news to the top of the pinned part, and
  // remove the Work folder with what it holds.
  const home = edited.spaces[0];
  assert.ok(home);
  home.title = 'Home again';
  byId('home-unpinned').childrenIds = [];
  byId('tab-news').parentID = 'home-pinned';
  byId('home-pinned').childrenIds = ['tab-news', 'note-plan'];
  edited.items = edited.items.filter(
    ({ id }) =>
      ![
        'folder-work',
        'tab-docs',
        'split-pair',
        'tab-left',
        'tab-right',
      ].includes(id),
  );
  // Remove the Side space with its containers and items; Profile 2 keeps
  // its favorites.
  edited.spaces = edited.spaces.filter(({ id }) => id !== 'side');
  edited.items = edited.items.filter(
    ({ id }) =>
      !['side-pinned', 'side-unpinned', 'folder-side', 'tab-side'].includes(id),
  );
  await writeSidebar(dir.path, edited);
  const changed = await written();

  assert.deepEqual(unchanged, {
    spaces: { count: 0, deleted: 0 },
    sidebarItems: { count: 0, deleted: 0 },
  });
  assert.deepEqual(changed, {
    spaces: { count: 1, deleted: 1 },
    sidebarItems: { count: 1, deleted: 7 },
  });
  assert.deepEqual(read('select id, title from spaces'), [
    { id: 'home', title: 'Home again' },
  ]);
  assert.deepEqual(
    read(
      "select id, section, parentId, position from sidebarItems where spaceId = 'home' order by id",
    ),
    [
      { id: 'note-plan', section: 'pinned', parentId: null, position: 1 },
      { id: 'tab-news', section: 'pinned', parentId: null, position: 0 },
    ],
  );
});

test('an import of one profile holds its spaces, their items and its favorites only', async () => {
  await using dir = await new TemporaryFiles().directory('arc-scope-');
  await writeSidebar(dir.path, sidebar());
  const { read, source, written } = await arcImport(
    dir.path,
    dir.path,
    globalThis,
    {
      collectionIds: ['Profile 2'],
    },
  );

  await written();

  assert.deepEqual(read('select id from spaces'), [{ id: 'side' }]);
  assert.deepEqual(read('select id, spaceId from sidebarItems order by id'), [
    { id: 'folder-side', spaceId: 'side' },
    { id: 'tab-chat', spaceId: null },
    { id: 'tab-side', spaceId: 'side' },
  ]);
  assert.deepEqual(source.coverage().selection, {
    collectionIds: ['Profile 2'],
  });
});

test('a watch loads each write of the sidebar, fails as config when it goes away, and stops when cancelled', async () => {
  await using dir = await new TemporaryFiles().directory('arc-watch-');
  const file = await writeSidebar(dir.path, sidebar());
  const { source, pipeline, read } = await arcImport(
    dir.path,
    dir.path,
    globalThis,
  );
  const renamed = sidebar();
  const space = renamed.spaces[1];
  assert.ok(space);
  space.title = 'Side renamed';
  const controller = new AbortController();
  const batches: {
    streams: string[];
    count: number;
    failures: string[];
  }[] = [];
  try {
    for await (const { outcomes } of pipeline.watch({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })) {
      batches.push({
        streams: outcomes.map(({ copy }) => copy.from.name).sort(),
        count: outcomes.reduce((sum, { count }) => sum + count, 0),
        failures: outcomes.flatMap(({ failures }) =>
          failures.map(({ failureType }) => failureType),
        ),
      });
      if (batches.length === 1) await writeSidebar(dir.path, renamed);
      // Arc's sidebar goes away while the watch runs.
      else if (batches.length === 2) await rm(file);
      else controller.abort();
    }
  } finally {
    controller.abort();
  }

  assert.deepEqual(batches, [
    { streams: ['sidebarItems', 'spaces'], count: 13, failures: [] },
    { streams: ['sidebarItems', 'spaces'], count: 1, failures: [] },
    {
      streams: ['sidebarItems', 'spaces'],
      count: 0,
      failures: ['config', 'config'],
    },
  ]);
  assert.deepEqual(read("select title from spaces where id = 'side'"), [
    { title: 'Side renamed' },
  ]);
  assert.equal(read('select count(*) n from sidebarItems')[0]?.n, 11);
  const stopped = source.watch({
    clock: globalThis,
    streams: [source.spaces],
    signal: AbortSignal.abort(),
  });
  assert.equal((await stopped.next()).done, true);
});

test('a watch over a sidebar that holds still runs no pass and records it current as of its last write', async (t) => {
  await using dir = await new TemporaryFiles().directory('arc-current-');
  const file = await writeSidebar(dir.path, sidebar());
  const lastWrite = new Date('2026-01-01T17:35:02.253Z');
  await utimes(file, lastWrite, lastWrite);
  // The pipeline's clock reads after the sidebar's last write.
  const clock = createClock(Date.parse('2026-10-22T00:00:00.000Z'));
  const { pipeline, read } = await arcImport(dir.path, dir.path, clock);
  const controller = new AbortController();
  const watching = pipeline.watch({
    // A check that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  try {
    await watching.next();
    // A pass that a check starts would come here.
    const after = watching.next();
    // The check is due once the watch waits for its next poll.
    await t.waitFor(() => assert.ok(clock.countTimers() > 0), {
      interval: 1,
      timeout: 10_000,
    });
    await clock.tickAsync(1000);

    // The watch's next check finds the file unchanged and records each
    // stream current as of the file's last write, with no pass.
    await timebox(
      () =>
        assert.deepEqual(
          read(
            'select stream, checked_at from _elt_stream_checks order by stream',
          ),
          [
            { stream: 'sidebarItems', checked_at: lastWrite.toISOString() },
            { stream: 'spaces', checked_at: lastWrite.toISOString() },
          ],
        ),
      {
        minTimeout: 100,
        maxRetryTime: 10_000,
        shouldRetry: ({ error }) => error instanceof assert.AssertionError,
      },
    );
    assert.deepEqual(
      read('select stream, current_as_of from stream_status order by stream'),
      [
        { stream: 'sidebarItems', current_as_of: lastWrite.toISOString() },
        { stream: 'spaces', current_as_of: lastWrite.toISOString() },
      ],
    );
    assert.deepEqual(read('select count(*) n from sync_attempts'), [{ n: 1 }]);
    controller.abort();
    assert.deepEqual(await after, { done: true, value: undefined });
  } finally {
    controller.abort();
    await watching.return(undefined);
  }
});

test('this Mac’s Arc sidebar loads read-only through the real pipeline', async (t) => {
  const file = join(
    homedir(),
    'Library/Application Support/Arc/StorableSidebar.json',
  );
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return t.skip('Arc’s sidebar is not on this Mac');
  }
  await using dir = await new TemporaryFiles().directory('arc-live-');
  const { read, written } = await arcImport(homedir(), dir.path, globalThis);

  const first = await written();
  const again = await written();

  // Counted from the file itself, not through the SDK: every item but the
  // containers of the spaces and favorites, and every space.
  const container = JSON.parse(text).sidebar.containers.find(
    (entry: { spaces?: unknown }) => entry.spaces !== undefined,
  );
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const objects = (list: unknown[]) => list.filter(isObject);
  const items = objects(container.items).filter(
    ({ data }) => isObject(data) && !('itemContainer' in data),
  ).length;
  const spaces = objects(container.spaces).length;
  assert.deepEqual(first, {
    spaces: { count: spaces, deleted: 0 },
    sidebarItems: { count: items, deleted: 0 },
  });
  assert.deepEqual(again, {
    spaces: { count: 0, deleted: 0 },
    sidebarItems: { count: 0, deleted: 0 },
  });
  assert.equal(read('select count(*) n from sidebarItems')[0]?.n, items);
  assert.equal(
    read(
      "select count(*) n from sidebarItems where kind = 'tab' and url is null",
    )[0]?.n,
    0,
  );
});
