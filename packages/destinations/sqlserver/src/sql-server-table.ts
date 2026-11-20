import {
  type Stream,
  Target,
  requireDescribed,
  targetFileReads,
} from '@eltjs/elt';

import { SqlServerColumn } from './sql-server-column.ts';
import { SqlServerColumns } from './sql-server-columns.ts';
import { identifiers, quote, rawTable } from './sql-server-identifiers.ts';

// A reusable target definition. Empty columns mean infer from the Copy's
// stream. The host names only the reader view in marts; the destination
// keeps the rows in the raw table in _warehouse. Both names and the columns'
// follow the destination's naming rule, so a field SQL Server cannot hold as
// it is still loads.
export class SqlServerTable extends Target {
  // The name readers query: the view in marts over the raw table.
  readonly name: string;
  // The table in _warehouse that the commits of the target write.
  readonly raw: string;
  readonly columns: readonly SqlServerColumn[];

  constructor(name: string, columns?: readonly SqlServerColumn[]) {
    const view = identifiers.reader(name);
    if (
      columns !== undefined &&
      (!Array.isArray(columns) ||
        columns.length === 0 ||
        !columns.every((column) => column instanceof SqlServerColumn))
    )
      throw new TypeError('A table requires at least one SQL Server column');
    super(targetFileReads(columns ?? []));
    this.name = view;
    this.raw = rawTable(view);
    this.columns = Object.freeze(
      identifiers
        .columns(columns ?? [])
        .map(([column, stored]) => column.named(stored)),
    );
    Object.freeze(this);
  }

  resolve(stream: Stream): SqlServerTable {
    if (this.columns.length === 0)
      return new SqlServerTable(
        this.name,
        SqlServerColumns.fromSchema(stream.jsonSchema),
      );
    requireDescribed(stream, this.columns);
    return this;
  }

  get quotedRaw(): string {
    return quote(this.raw);
  }
}
