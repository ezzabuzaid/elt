import type { SqlServerRow } from './sql-server-row.ts';
import type { SqlServerValue } from './values.ts';

// A key that changed: its row as it is now, or its primary key values, in
// key order, when the row is gone.
export type SqlServerChange =
  | { readonly type: 'upsert'; readonly row: SqlServerRow }
  | { readonly type: 'delete'; readonly key: readonly SqlServerValue[] };

// A point in one table's change history: a Change Tracking version, and the
// tracking generation it belongs to.
export type ChangePosition = {
  readonly version: string;
  readonly generation: string;
};

// One table's changes since a position, and the position they bring it to.
// Reading every change completes the read; disposing before that stops the
// statement still streaming, then abandons the read.
export class ChangeSet
  implements AsyncIterable<SqlServerChange>, AsyncDisposable
{
  readonly position: ChangePosition;
  readonly #changes: AsyncGenerator<SqlServerChange>;
  readonly #close: () => Promise<void>;

  constructor(
    position: ChangePosition,
    changes: AsyncGenerator<SqlServerChange>,
    close: () => Promise<void>,
  ) {
    this.position = position;
    this.#changes = changes;
    this.#close = close;
    Object.freeze(this);
  }

  [Symbol.asyncIterator](): AsyncIterator<SqlServerChange> {
    return this.#changes;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#changes.return(undefined);
    await this.#close();
  }
}
