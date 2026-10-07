import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
} from '@workspace/elt';
import {
  ChangeHistoryExpiredError,
  type ChangePosition,
  type SqlServerSession,
  type SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

import { SqlServerStream, pageSize } from './sql-server-stream.ts';

// Where a read stands: loading every row from a position in the table's
// change history, up to and including the key `after`; or loaded, reading
// what changed since the position.
type ChangeTrackingState =
  | {
      readonly initial: {
        readonly from: ChangePosition;
        readonly after: readonly string[];
      };
    }
  | { readonly from: ChangePosition };

function position(value: unknown): ChangePosition | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    'generation' in value &&
    typeof value.generation === 'string'
    ? { version: value.version, generation: value.generation }
    : undefined;
}

function parse(state: unknown): ChangeTrackingState | null {
  if (state === null) return null;
  if (typeof state === 'object' && 'from' in state) {
    const from = position(state.from);
    if (from !== undefined) return { from };
  }
  if (
    typeof state === 'object' &&
    'initial' in state &&
    typeof state.initial === 'object' &&
    state.initial !== null &&
    'from' in state.initial &&
    'after' in state.initial &&
    Array.isArray(state.initial.after) &&
    state.initial.after.every((part) => typeof part === 'string')
  ) {
    const from = position(state.initial.from);
    if (from !== undefined)
      return { initial: { from, after: state.initial.after } };
  }
  throw new TypeError(`Unknown Change Tracking state ${JSON.stringify(state)}`);
}

// A table SQL Server tracks changes of, which the login may read: the first
// read loads every row, page by page, from the position current before it
// began; later reads apply what changed since, deletions included. When the
// history no longer reaches back to the saved position (cleanup, a truncate,
// tracking turned off and on), the stream starts over with a RESET and loads
// every row again.
export class ChangeTrackingStream extends SqlServerStream {
  constructor(table: SqlServerTable) {
    super(table, {
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      strategy:
        'Read through SQL Server Change Tracking: inserts, updates and deletions apply.',
    });
  }

  coverage(): ExtractionCoverage {
    return {
      description: `Every row of ${this.table.quoted} the login can read, then what Change Tracking reports changed`,
      selection: { table: this.table.quoted },
    };
  }

  async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    session: SqlServerSession,
  ): AsyncGenerator<SourceMessage> {
    if (configuration.syncMode === 'full_refresh') {
      yield* this.everyRow(session);
      return;
    }
    const saved = parse(state);
    if (saved === null) {
      yield* this.#load(
        session,
        await session.changeTrackingPosition(this.table),
        null,
      );
      return;
    }
    if ('initial' in saved) {
      yield* this.#load(session, saved.initial.from, saved.initial.after);
      return;
    }
    try {
      yield* this.#changes(session, saved.from);
    } catch (error) {
      if (!(error instanceof ChangeHistoryExpiredError)) throw error;
      // Whatever the expired read already yielded, the reset drops.
      yield { type: 'RESET', stream: this.stream.name };
      yield* this.#load(
        session,
        await session.changeTrackingPosition(this.table),
        null,
      );
    }
  }

  // Every row, from a position read before the first page, so a change made
  // during the load is read again by the next delta.
  async *#load(
    session: SqlServerSession,
    from: ChangePosition,
    after: readonly string[] | null,
  ): AsyncGenerator<SourceMessage> {
    const { name } = this.stream;
    if (!this.table.pageable) {
      yield* this.everyRow(session);
      yield { type: 'STATE', stream: name, state: { from } };
      return;
    }
    let last = after;
    for (;;) {
      let count = 0;
      for await (const row of session.page(this.table, last, pageSize)) {
        yield this.message(row);
        last = row.position;
        count += 1;
      }
      if (count < pageSize) break;
      yield {
        type: 'STATE',
        stream: name,
        state: { initial: { from, after: last } },
      };
    }
    yield { type: 'STATE', stream: name, state: { from } };
  }

  async *#changes(
    session: SqlServerSession,
    since: ChangePosition,
  ): AsyncGenerator<SourceMessage> {
    const { name } = this.stream;
    let reached: ChangePosition;
    {
      await using set = await session.changes(this.table, since);
      for await (const change of set)
        yield change.type === 'upsert'
          ? this.message(change.row)
          : { type: 'DELETE', stream: name, key: this.fields.key(change.key) };
      reached = set.position;
    }
    yield { type: 'STATE', stream: name, state: { from: reached } };
  }
}
