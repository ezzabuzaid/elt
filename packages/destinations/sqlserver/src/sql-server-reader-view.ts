import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import type { TargetDescriptions } from './sql-server-descriptions.ts';
import { quote } from './sql-server-identifiers.ts';
import { inMarts, marts } from './sql-server-schemas.ts';

// The position a reader reads at: the one a reading set in its session
// context, or, for a session that set none, past every commit, so the view
// shows the target as it is now and no row of its history (ADR 0010).
const position = `ISNULL(TRY_CAST(SESSION_CONTEXT(N'elt.position') AS bigint), 9223372036854775807)`;

// The view in marts that readers see a target through: exactly the stream's
// columns and loaded_at, none of the internal ones, made with the target and
// described by the descriptions of those columns. It reads the target as of
// the position its reader set: the rows that the target had then, and that
// it still has or its history kept.
export class TargetReaderView {
  readonly #name: string;
  readonly #target: string;
  readonly #history: string;
  readonly #columns: readonly string[];
  readonly #descriptions: TargetDescriptions;

  constructor(
    name: string,
    target: string,
    history: string,
    columns: readonly string[],
    descriptions: TargetDescriptions,
  ) {
    this.#name = name;
    this.#target = target;
    this.#history = history;
    this.#columns = columns;
    this.#descriptions = descriptions;
    Object.freeze(this);
  }

  get qualifiedName(): string {
    return inMarts(this.#name);
  }

  // Refuses, before anything is read, a reader view this load did not make:
  // not a view, or a view of other columns or another table. A stale
  // target's view still shows the stored columns, which evolving it replaces.
  async refuse(connection: SqlServerConnection, stale: boolean): Promise<void> {
    const view = this.qualifiedName;
    const [existing] = await connection.query(
      `SELECT o.[type],
         (SELECT c.[name] FROM sys.columns AS c WHERE c.[object_id] = o.[object_id] ORDER BY c.[column_id] FOR JSON PATH) AS [columns],
         IIF(EXISTS (SELECT 1 FROM sys.sql_expression_dependencies AS d WHERE d.[referencing_id] = o.[object_id] AND d.[referenced_id] = OBJECT_ID(@target)), 1, 0) AS [reads]
       FROM sys.objects AS o WHERE o.[object_id] = OBJECT_ID(@view)`,
      { view, target: this.#target },
    );
    if (existing === undefined) return;
    const columns: unknown = JSON.parse(String(existing.columns ?? '[]'));
    const named = Array.isArray(columns)
      ? columns.map((column: unknown) => String(Object(column).name))
      : [];
    if (
      String(existing.type).trim() !== 'V' ||
      existing.reads !== 1 ||
      (!stale && named.join('\0') !== this.#columns.join('\0'))
    )
      throw new TypeError(
        `${view} is not a view of exactly ${this.#target}; drop it or reset the warehouse`,
      );
  }

  // Made only when absent and never replaced by a commit: prepare refused any
  // view not this load's own.
  async describe(connection: SqlServerConnection): Promise<void> {
    const [existing] = await connection.query(
      `SELECT IIF(OBJECT_ID(@view, N'V') IS NULL, 0, 1) AS [made]`,
      { view: this.qualifiedName },
    );
    if (existing?.made !== 1) await this.#define(connection, 'CREATE');
    await this.#descriptions.write(connection, 'VIEW', marts, this.#name);
  }

  // Defined again over a target that took the place of another, whose
  // columns it then shows, with its grants and the views over it kept.
  async replace(connection: SqlServerConnection): Promise<void> {
    await this.#define(connection, 'CREATE OR ALTER');
    await this.#descriptions.write(connection, 'VIEW', marts, this.#name);
  }

  // CREATE VIEW must be the only statement of its batch.
  async #define(
    connection: SqlServerConnection,
    verb: 'CREATE' | 'CREATE OR ALTER',
  ): Promise<void> {
    const columns = this.#columns.map(quote).join(', ');
    const kept = this.#columns.map((column) => `o.${quote(column)}`);
    await connection.query(
      `${verb} VIEW ${this.qualifiedName} AS SELECT ${columns} FROM ${this.#target} WHERE [committed_in] <= ${position} UNION ALL SELECT ${kept.join(', ')} FROM ${this.#history} AS o WHERE o.[committed_in] <= ${position} AND o.[replaced_in] > ${position}`,
    );
  }
}
