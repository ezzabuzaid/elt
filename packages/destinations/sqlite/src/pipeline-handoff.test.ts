import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type Partition,
  Pipeline,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

test(
  'a replacement pipeline waits for a cancelled run to release its checkpoint and resumes saved progress',
  {
    timeout: 10_000,
    todo: 'The checkpoint store fails fast on a held key, so the replacement fails with "in use by another run"; #2574 keeps a replacement from starting while the old run still executes.',
  },
  async (t) => {
    const committed = Promise.withResolvers<void>();
    const stopping = Promise.withResolvers<void>();
    const finishStopping = Promise.withResolvers<void>();
    // Also unblock teardown if an unexpected regression reaches the test timeout.
    t.signal.addEventListener('abort', () => finishStopping.resolve(), {
      once: true,
    });

    // An app source cannot reliably be paused during shutdown. This source uses
    // a gate at that boundary; the pipeline, SQLite writer and checkpoint locks
    // are real. Both instances expose the same two records and durable cursor.
    class PausingSource extends Source {
      readonly identity = 'handoff';
      readonly records = new Stream({
        name: 'records',
        jsonSchema: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
        primaryKey: ['id'],
        supportedSyncModes: ['full_refresh', 'incremental'],
        sourceDefinedCursor: true,
      });
      protected readonly catalog = new Catalog([this.records]);
      readonly pauseOnClose: boolean;

      constructor(pauseOnClose: boolean) {
        super();
        this.pauseOnClose = pauseOnClose;
      }

      override coverage() {
        return {
          description: 'Two records with an increasing cursor.',
          selection: {},
        };
      }

      protected override async open() {
        const context = new AsyncDisposableStack();
        if (this.pauseOnClose)
          context.defer(async () => {
            stopping.resolve();
            await finishStopping.promise;
          });
        return context;
      }

      protected override async *observe({ streams }: SourceWatchOptions) {
        yield streams;
      }

      protected override async *extract(
        configuration: CopyConfiguration,
        state: unknown,
        _partition: Partition | null,
        _context: AsyncDisposable,
        signal?: AbortSignal,
      ): AsyncGenerator<SourceMessage> {
        const cursor = typeof state === 'number' ? state : 0;
        for (let id = cursor + 1; id <= 2; id++) {
          yield { stream: configuration.stream.name, data: { id } };
          yield { type: 'STATE', stream: configuration.stream.name, state: id };
          if (this.pauseOnClose) {
            committed.resolve();
            assert.ok(signal);
            if (!signal.aborted) await once(signal, 'abort');
            signal.throwIfAborted();
          }
        }
      }
    }

    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-handoff-'),
    );
    const createPipeline = async (source: PausingSource) => {
      const destination = new SQLiteDestination({
        path: join(scratch.path, 'records.sqlite'),
      });
      const history = new SQLiteSyncHistory();
      await history.install([destination]);
      const copy = new Copy(source.records, destination.table('records'), {
        id: 'records',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      });
      return new Pipeline({
        history,
        connections: [
          new Connection({
            name: 'handoff',
            source,
            destination,
            steps: [copy],
            checkpoints: new SQLiteCheckpointStore({
              path: join(scratch.path, 'state.sqlite'),
            }),
          }),
        ],
      });
    };
    const first = await createPipeline(new PausingSource(true));
    const replacement = await createPipeline(new PausingSource(false));
    const cancelled = new AbortController();
    const reason = new Error('The previous import lost ownership');
    const firstRun = first.run({
      signal: AbortSignal.any([cancelled.signal, t.signal]),
    });
    const firstStopped = assert.rejects(firstRun, (error) => error === reason);
    // Attach rejection handlers immediately, including on assertion failures.
    const settled: Promise<unknown>[] = [
      Promise.allSettled([firstRun, firstStopped]),
    ];

    try {
      await Promise.race([committed.promise, firstRun]);
      cancelled.abort(reason);
      await Promise.race([stopping.promise, firstRun]);

      // Cancellation has reached the first source, but shutdown still owns the
      // checkpoint. A new run must wait rather than report a failed import.
      const replacementRun = replacement.run({ signal: t.signal });
      settled.push(Promise.allSettled([replacementRun]));
      await Promise.race([
        replacementRun.then(() =>
          assert.fail(
            'The replacement ran before the previous run released its checkpoint',
          ),
        ),
        // This is only an observation window, not a production lease deadline.
        sleep(100, undefined, { signal: t.signal }),
      ]);

      finishStopping.resolve();
      await firstStopped;
      const results = await replacementRun;
      // One remaining record proves the replacement resumed the committed cursor
      // instead of replaying both records or skipping the rest of the import.
      assert.deepEqual(
        results.map(({ count, deleted }) => ({ count, deleted })),
        [{ count: 1, deleted: 0 }],
      );
    } finally {
      cancelled.abort(reason);
      finishStopping.resolve();
      await Promise.all(settled);
    }
  },
);
