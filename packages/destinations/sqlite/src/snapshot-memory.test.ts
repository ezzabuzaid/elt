import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Two passes of STREAMS snapshot streams of KEYS records each, shaped like
// Calendar's icsParameters, into OUT, in a process whose heap the test caps.
// SYNC_MODE selects the copies' sync mode, and GROUPED reads each scan
// through diffGroupedSnapshot in groups of 20 keys. The second pass changes
// one record of each stream, so an incremental pass diffs every scan against
// the snapshot the first saved.
const passes = `
  const { Catalog, Connection, Copy, Pipeline, Source, Stream, diffGroupedSnapshot, diffSnapshot } = await import('@workspace/elt');
  const { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } = await import(process.env.DESTINATION);
  const { ClosedWorld } = await import('@zukhruf/snapshot-differential');
  const keys = Number(process.env.KEYS);
  const fullRefresh = process.env.SYNC_MODE === 'full_refresh';
  const grouped = process.env.GROUPED === '1';
  const item = (key) => (Math.floor(key / 20) * 2654435761 >>> 0).toString(16).padStart(8, '0') + '-1111-4222-8333-' + String(key).padStart(12, '0');
  class Parameters extends Source {
    identity = 'parameters';
    streams = Array.from({ length: Number(process.env.STREAMS) }, (_, index) => new Stream({
      name: 'parameters' + index,
      jsonSchema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } } },
      primaryKey: ['id'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      supportedSyncModes: ['full_refresh', 'incremental'],
    }));
    catalog = new Catalog(this.streams);
    pass = 1;
    coverage() { return { description: 'synthetic', selection: {} }; }
    async currentAsOf() { return null; }
    async open() { return new AsyncDisposableStack(); }
    async *observe({ streams }) { yield streams; }
    async *extract(configuration, state) {
      const pass = this.pass;
      function* records(from, to) {
        for (let key = from; key < to; key++)
          yield {
            id: JSON.stringify(['E6A1F0C2-7B3D-4C1E-9A55-0F7E2D9B8C11', item(key) + '@google.com', 'VCALENDAR/VEVENT', key % 20, key % 3, 0]),
            value: key === 0 ? 'pass ' + pass : 'Person ' + (key % 997),
          };
      }
      function* groups() {
        for (let group = 0; group * 20 < keys; group++)
          yield {
            key: String(group),
            fingerprint: group === 0 ? 'pass ' + pass : 'unchanged',
            records: () => records(group * 20, Math.min(keys, group * 20 + 20)),
          };
      }
      if (grouped)
        yield* diffGroupedSnapshot(configuration, groups(), state, { policy: new ClosedWorld() });
      else yield* diffSnapshot(configuration, records(0, keys), state, { policy: new ClosedWorld() });
    }
  }
  const source = new Parameters();
  const destination = new SQLiteDestination({ path: process.env.OUT + '/data.sqlite' });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  const pipeline = new Pipeline({
    history,
    connections: [new Connection({
      name: 'parameters',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: process.env.OUT + '/checkpoints.sqlite' }),
      steps: source.streams.map((stream) => new Copy(stream, destination.table('raw_' + stream.name), fullRefresh
        ? { id: stream.name, syncMode: 'full_refresh', destinationSyncMode: 'overwrite' }
        : { id: stream.name, syncMode: 'incremental', destinationSyncMode: 'append_dedup' })),
    })],
  });
  await pipeline.run();
  source.pass = 2;
  await pipeline.run();
`;

function runPasses(
  out: string,
  {
    streams,
    keys,
    heapMb,
    syncMode = 'incremental',
    grouped = false,
  }: {
    streams: number;
    keys: number;
    heapMb: number;
    syncMode?: 'incremental' | 'full_refresh';
    grouped?: boolean;
  },
) {
  const run = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMb}`, '--input-type=module', '-e', passes],
    {
      // The package's own folder, where its dependencies resolve.
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        DESTINATION: pathToFileURL(join(import.meta.dirname, 'index.ts')).href,
        OUT: out,
        STREAMS: String(streams),
        KEYS: String(keys),
        SYNC_MODE: syncMode,
        GROUPED: grouped ? '1' : '0',
      },
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  // V8 names a heap limit it reached in the first lines it writes.
  assert.equal(
    run.status,
    0,
    `${run.signal ?? ''} ${run.error?.message ?? ''}\n${run.stderr.slice(0, 1000)}`,
  );
  using data = new DatabaseSync(join(out, 'data.sqlite'), { readOnly: true });
  return data
    .prepare(
      'SELECT stream, status, written_count FROM extraction_coverage WHERE attempt_id = (SELECT max(attempt_id) FROM sync_attempts) ORDER BY stream',
    )
    .all()
    .map((row) => ({ ...row }));
}

test('a snapshot pass holds its saved state once, so a large snapshot diffs in a heap little larger than the diff needs', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'elt-snapshot-memory-'),
  );

  // 200,000 keys save about 38 MB of state, and comparing a scan with it
  // takes the differential itself about 110 MB. A pass that copies the
  // state, or keeps one it no longer needs, runs out of the cap.
  const loaded = runPasses(directory.path, {
    streams: 1,
    keys: 200_000,
    heapMb: 160,
  });

  assert.deepEqual(loaded, [
    { stream: 'parameters0', status: 'succeeded', written_count: 1 },
  ]);
});

test('a pass holds only the saved state of the stream it reads, so many large snapshots diff in a heap that one fits', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'elt-snapshot-memory-'),
  );

  // Each stream's 100,000 keys save about 19 MB of state; a pass that diffs
  // them one at a time needs about 80 MB, and one that holds all eight
  // states at once needs over 128 MB.
  const loaded = runPasses(directory.path, {
    streams: 8,
    keys: 100_000,
    heapMb: 100,
  });

  assert.deepEqual(
    loaded,
    Array.from({ length: 8 }, (_, index) => ({
      stream: `parameters${index}`,
      status: 'succeeded',
      written_count: 1,
    })),
  );
});

test('a full refresh holds no snapshot, so it loads a scan in a heap far smaller than a diff of it needs', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'elt-snapshot-memory-'),
  );

  // A full refresh yields each record as the scan does: 400,000 of them load
  // in about 8 MB. Holding the scan takes over 64 MB, and diffing it with
  // the empty snapshot of a full refresh over 96 MB.
  const loaded = runPasses(directory.path, {
    streams: 1,
    keys: 400_000,
    heapMb: 24,
    syncMode: 'full_refresh',
  });

  assert.deepEqual(loaded, [
    { stream: 'parameters0', status: 'succeeded', written_count: 400_000 },
  ]);
});

test('a grouped full refresh reads its groups one record at a time, in the same small heap', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'elt-snapshot-memory-'),
  );

  const loaded = runPasses(directory.path, {
    streams: 1,
    keys: 400_000,
    heapMb: 24,
    syncMode: 'full_refresh',
    grouped: true,
  });

  assert.deepEqual(loaded, [
    { stream: 'parameters0', status: 'succeeded', written_count: 400_000 },
  ]);
});
