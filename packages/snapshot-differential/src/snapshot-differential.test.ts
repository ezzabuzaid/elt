import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ClosedWorld,
  Coverage,
  type DeletionPolicy,
  Retention,
  type SnapshotChange,
  SnapshotDifferential,
  type SnapshotGroup,
} from './index.ts';

type Item = { readonly id: string; readonly value: string };

function items(
  policy: DeletionPolicy,
  expiresBy?: string,
): SnapshotDifferential<Item> {
  return new SnapshotDifferential<Item>({
    name: 'items',
    primaryKey: ['id'],
    key: (record) => JSON.stringify([record.id]),
    expiresBy,
    policy,
  });
}

// The ids one diff upserted and deleted, and the state it saved last.
async function changes<State>(
  diff: AsyncIterable<SnapshotChange<Item, State>>,
): Promise<{ upserted: string[]; deleted: string[]; state: State }> {
  const upserted: string[] = [];
  const deleted: string[] = [];
  const states: State[] = [];
  for await (const change of diff)
    if (change.type === 'upsert') upserted.push(change.record.id);
    else if (change.type === 'delete') deleted.push(String(change.key.id));
    else states.push(change.state);
  const [state, ...more] = states;
  assert.ok(state !== undefined && more.length === 0, 'one state, last');
  return { upserted, deleted, state };
}

function group(
  key: string,
  fingerprint: string | null,
  records: readonly Item[],
): SnapshotGroup<Item> {
  return { key, fingerprint, records: () => records };
}

test('a scan yields new and changed records, and an identical rescan yields nothing and saves the same state', async () => {
  const policy = new ClosedWorld();

  const first = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      null,
    ),
  );
  const changed = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '2' },
      ],
      first.state,
    ),
  );
  const again = await changes(
    items(policy).diff(
      [
        { id: 'b', value: '2' },
        { id: 'a', value: '1' },
      ],
      changed.state,
    ),
  );

  assert.deepEqual(first.upserted, ['a', 'b']);
  assert.deepEqual(changed.upserted, ['b']);
  assert.deepEqual(again.upserted, []);
  assert.equal(JSON.stringify(again.state), JSON.stringify(changed.state));
});

test('under the closed-world assumption a key the scan does not list is deleted and leaves the snapshot', async () => {
  const policy = new ClosedWorld();
  const first = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      null,
    ),
  );

  const second = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], first.state),
  );
  const third = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], second.state),
  );

  assert.deepEqual(second.deleted, ['b']);
  assert.deepEqual(third.deleted, []);
  assert.deepEqual(Object.keys(second.state.snapshot), ['["a"]']);
});

test('under retention a key that vanished before the horizon expired and one after it was deleted', async () => {
  type Seen = Item & { readonly seenAt: string };
  const seen = (policy: DeletionPolicy) =>
    new SnapshotDifferential<Seen>({
      name: 'seen',
      primaryKey: ['id'],
      key: (record) => JSON.stringify([record.id]),
      expiresBy: 'seenAt',
      policy,
    });
  const first = await changes(
    seen(new ClosedWorld()).diff(
      [
        { id: 'old', value: '1', seenAt: '2026-01-01T00:00:00.000Z' },
        { id: 'early', value: '1', seenAt: '2026-01-31T23:59:59.999Z' },
        { id: 'edge', value: '1', seenAt: '2026-02-01T00:00:00.000Z' },
        { id: 'recent', value: '1', seenAt: '2026-03-01T00:00:00.000Z' },
      ],
      null,
    ),
  );

  const second = await changes(
    seen(new Retention('2026-02-01T00:00:00.000Z')).diff([], first.state),
  );

  assert.deepEqual(second.deleted, ['edge', 'recent']);
  assert.deepEqual(second.state.snapshot, {});
  assert.throws(
    () => new Retention('yesterday'),
    /Retention horizon yesterday is not a timestamp/,
  );
  await assert.rejects(
    Array.fromAsync(
      seen(new ClosedWorld()).diff(
        [{ id: 'x', value: '1', seenAt: 'yesterday' }],
        null,
      ),
    ),
    /must carry seenAt as a timestamp to expire/,
  );
});

test('under coverage a key outside what the scan covers stays unknown until a scan covers it, and comes back unchanged without a write', async () => {
  const outside = new Coverage(({ key }) => key.id !== 'b');
  const everything = new Coverage(() => true);
  const first = await changes(
    items(everything).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
        { id: 'c', value: '1' },
      ],
      null,
    ),
  );

  // b and c leave the scan; only c is where the scan covers.
  const evicted = await changes(
    items(outside).diff([{ id: 'a', value: '1' }], first.state),
  );
  // b's range comes back without b: it was deleted meanwhile.
  const covered = await changes(
    items(everything).diff([{ id: 'a', value: '1' }], evicted.state),
  );
  // b's range comes back with b as it was.
  const returned = await changes(
    items(everything).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      evicted.state,
    ),
  );

  assert.deepEqual(evicted.deleted, ['c']);
  assert.deepEqual(Object.keys(evicted.state.snapshot), ['["a"]', '["b"]']);
  assert.deepEqual(covered.deleted, ['b']);
  assert.deepEqual(Object.keys(covered.state.snapshot), ['["a"]']);
  assert.deepEqual(returned.upserted, []);
  assert.deepEqual(returned.deleted, []);
});

test('a record outside the lookback window leaves the snapshot and is never deleted', async () => {
  const policy = new ClosedWorld();
  const window = { rereads: (record: Item) => record.value >= '2' };
  const first = await changes(
    items(policy).diff(
      [
        { id: 'settled', value: '1' },
        { id: 'restated', value: '2' },
      ],
      null,
      window,
    ),
  );

  const second = await changes(
    items(policy).diff([{ id: 'restated', value: '2' }], first.state, window),
  );

  assert.deepEqual(Object.keys(first.state.snapshot), ['["restated"]']);
  assert.deepEqual(second.upserted, []);
  assert.deepEqual(second.deleted, []);
});

test('a grouped scan keeps an unchanged group unread, follows a record that moves between groups, and keeps unknown keys after their group vanishes', async () => {
  const everything = new Coverage(() => true);
  const unread: SnapshotGroup<Item> = {
    key: 'one',
    fingerprint: 'v1',
    records: () => {
      throw new Error('An unchanged group was read');
    },
  };
  const first = await changes(
    items(everything).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      null,
    ),
  );

  // two empties and three takes b over unchanged.
  const moved = await changes(
    items(everything).diffGroups(
      [
        unread,
        group('two', 'v2', []),
        group('three', 'v1', [{ id: 'b', value: '1' }]),
      ],
      first.state,
    ),
  );
  // three vanishes, outside what the scan covers.
  const evicted = await changes(
    items(new Coverage(({ key }) => key.id !== 'b')).diffGroups(
      [unread, group('two', 'v2', [])],
      moved.state,
    ),
  );
  const covered = await changes(
    items(everything).diffGroups(
      [unread, group('two', 'v2', [])],
      evicted.state,
    ),
  );

  assert.deepEqual(first.upserted, ['a', 'b']);
  assert.deepEqual(moved.upserted, []);
  assert.deepEqual(moved.deleted, []);
  assert.deepEqual(evicted.deleted, []);
  assert.deepEqual(Object.keys(evicted.state.unknown ?? {}), ['["b"]']);
  assert.deepEqual(covered.deleted, ['b']);
  assert.equal(covered.state.unknown, undefined);
});

test('a scan that lists a key or a group twice, holds a record JSON cannot hold, or reads foreign state fails', async () => {
  const policy = new ClosedWorld();
  const loose = new SnapshotDifferential<Record<string, unknown>>({
    name: 'loose',
    primaryKey: ['id'],
    key: (record) => JSON.stringify([record.id]),
    policy,
  });

  const failures: [AsyncIterable<unknown>, RegExp][] = [
    [
      items(policy).diff(
        [
          { id: 'a', value: '1' },
          { id: 'a', value: '2' },
        ],
        null,
      ),
      /Snapshot items returned id a twice in one scan/,
    ],
    [
      items(policy).diffGroups(
        [group('g', 'v1', []), group('g', 'v1', [])],
        null,
      ),
      /Snapshot items returned group g twice in one scan/,
    ],
    [
      loose.diff([{ id: 'a', value: undefined }], null),
      /must be losslessly JSON serializable/,
    ],
    [
      items(policy).diff([], { snapshot: { '["a"]': 1 } }),
      /Snapshot items state is not a saved snapshot/,
    ],
  ];

  for (const [diff, message] of failures)
    await assert.rejects(Array.fromAsync(diff), message);
});
