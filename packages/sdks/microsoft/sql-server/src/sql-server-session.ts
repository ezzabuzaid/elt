import sql from 'mssql';

import {
  cellBoolean,
  cellNullableText,
  cellNumber,
  cellText,
} from './cells.ts';
import {
  type ChangePosition,
  ChangeSet,
  type SqlServerChange,
} from './change-set.ts';
import { type ColumnType, codecFor, declaredType } from './codecs/codec-for.ts';
import {
  ChangeHistoryExpiredError,
  SqlServerPermissionError,
} from './errors.ts';
import { SqlServerColumn } from './sql-server-column.ts';
import { query, stream } from './sql-server-request.ts';
import { SqlServerRow } from './sql-server-row.ts';
import { type ChangeTracking, SqlServerTable } from './sql-server-table.ts';
import type { SqlServerValue } from './values.ts';

// Where the database's changes stand: the last committed Change Tracking
// version (null while tracking is off) and the last rowversion handed out.
// Either moving means some table changed.
export type SqlServerVersion = {
  readonly changeTracking: string | null;
  readonly rowversion: string;
};

// User tables only: not the system's own, not external tables (their rows
// live elsewhere), and not the change tables CDC keeps.
const tablesQuery = `
SELECT t.object_id, s.name, t.name,
  CONVERT(nvarchar(max), ep.value),
  CASE
    WHEN ctt.object_id IS NULL THEN 'off'
    WHEN HAS_PERMS_BY_NAME(QUOTENAME(s.name) + '.' + QUOTENAME(t.name), 'OBJECT', 'VIEW CHANGE TRACKING') = 1 THEN 'readable'
    ELSE 'denied'
  END
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
LEFT JOIN sys.extended_properties AS ep
  ON ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
LEFT JOIN sys.change_tracking_tables AS ctt ON ctt.object_id = t.object_id
WHERE t.is_ms_shipped = 0 AND t.is_external = 0 AND s.name <> 'cdc'
ORDER BY s.name, t.name`;

// TYPE_NAME(system_type_id) is the system type an alias type is built on; a
// login that cannot see an alias type would otherwise lose its columns. CLR
// types share one system type, so they keep their own name.
const columnsQuery = `
SELECT c.object_id, c.name, COALESCE(TYPE_NAME(c.system_type_id), ty.name),
  CAST(COALESCE(ty.is_assembly_type, CASE WHEN c.system_type_id = 240 THEN 1 ELSE 0 END) AS bit),
  CAST(c.max_length AS int), CAST(c.precision AS int), CAST(c.scale AS int),
  c.is_nullable, c.is_masked, c.collation_name,
  CONVERT(nvarchar(max), ep.value),
  HAS_PERMS_BY_NAME(QUOTENAME(OBJECT_SCHEMA_NAME(c.object_id)) + '.' + QUOTENAME(OBJECT_NAME(c.object_id)), 'OBJECT', 'SELECT', c.name, 'COLUMN')
FROM sys.columns AS c
JOIN sys.tables AS t ON t.object_id = c.object_id
LEFT JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.extended_properties AS ep
  ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
WHERE t.is_ms_shipped = 0
ORDER BY c.object_id, c.column_id`;

// A table's tracking generation. A truncate starts its history over at the
// current version (begin_version) and re-enabling tracking recreates its
// change table (create_date); either way the changes before it are gone, and
// the minimum valid version alone does not show it when nothing else changed.
const generationQuery = `(SELECT CONVERT(varchar(20), ctt.begin_version) + '@' + CONVERT(varchar(30), it.create_date, 126)
  FROM sys.change_tracking_tables AS ctt
  JOIN sys.internal_tables AS it ON it.parent_object_id = ctt.object_id AND it.internal_type_desc = 'CHANGE_TRACKING'
  WHERE ctt.object_id = OBJECT_ID(@p0))`;

const primaryKeysQuery = `
SELECT ic.object_id, c.name
FROM sys.indexes AS i
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.is_primary_key = 1
ORDER BY ic.object_id, ic.key_ordinal`;

// One run's connections to the database. Reads hold no transaction between
// statements, except one short snapshot transaction around a Change
// Tracking delta when the database allows snapshot isolation.
export class SqlServerSession implements AsyncDisposable {
  readonly #pool: sql.ConnectionPool;
  readonly #location: string;
  // ALLOW_SNAPSHOT_ISOLATION is on, so a delta can read in one snapshot.
  readonly #snapshot: boolean;

  constructor(
    pool: sql.ConnectionPool,
    location: string,
    snapshotIsolation: boolean,
  ) {
    this.#pool = pool;
    this.#location = location;
    this.#snapshot = snapshotIsolation;
    Object.freeze(this);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#pool.close();
  }

  // Every user table, with the columns, primary key and Change Tracking the
  // login can read.
  async tables(): Promise<SqlServerTable[]> {
    const [tables, columns, keys] = await Promise.all([
      query(this.#pool.request(), tablesQuery),
      query(this.#pool.request(), columnsQuery),
      query(this.#pool.request(), primaryKeysQuery),
    ]);
    const columnsOf = groupBy(columns);
    const keysOf = groupBy(keys);
    return tables.map(([id, schema, name, description, changeTracking]) => {
      const readable: SqlServerColumn[] = [];
      const unreadable: string[] = [];
      for (const row of columnsOf.get(cellNumber(id, 'object_id')) ?? []) {
        const [
          ,
          columnName,
          typeName,
          clr,
          maxLength,
          precision,
          scale,
          nullable,
          masked,
          collation,
          comment,
          granted,
        ] = row;
        const type: ColumnType = {
          name: cellNullableText(typeName, 'type'),
          clr: cellBoolean(clr, 'is_assembly_type'),
          maxLength: cellNumber(maxLength, 'max_length'),
          precision: cellNumber(precision, 'precision'),
          scale: cellNumber(scale, 'scale'),
          collation: cellNullableText(collation, 'collation_name'),
        };
        const column = cellText(columnName, 'column name');
        if (granted !== 1) {
          unreadable.push(column);
          continue;
        }
        readable.push(
          new SqlServerColumn({
            name: column,
            type: declaredType(type),
            nullable: cellBoolean(nullable, 'is_nullable'),
            masked: cellBoolean(masked, 'is_masked'),
            description: cellNullableText(comment, 'MS_Description'),
            codec: codecFor(type),
          }),
        );
      }
      const keyNames = (keysOf.get(cellNumber(id, 'object_id')) ?? []).map(
        ([, key]) => cellText(key, 'key column'),
      );
      const primaryKey = keyNames.flatMap(
        (key) => readable.find((column) => column.name === key) ?? [],
      );
      return new SqlServerTable({
        schema: cellText(schema, 'schema'),
        name: cellText(name, 'table'),
        description: cellNullableText(description, 'MS_Description'),
        columns: readable,
        unreadable,
        // A key the login cannot read in full cannot identify rows.
        primaryKey: primaryKey.length === keyNames.length ? primaryKey : [],
        changeTracking: trackingState(
          cellText(changeTracking, 'change tracking'),
        ),
      });
    });
  }

  async version(): Promise<SqlServerVersion> {
    const [[changeTracking, rowversion] = []] = await query(
      this.#pool.request(),
      'SELECT CONVERT(varchar(20), CHANGE_TRACKING_CURRENT_VERSION()), CONVERT(varchar(20), CAST(@@DBTS AS bigint))',
    );
    return Object.freeze({
      changeTracking: cellNullableText(
        changeTracking,
        'change tracking version',
      ),
      rowversion: cellText(rowversion, '@@DBTS'),
    });
  }

  // Where a full read of the table starts in its change history: read it
  // before the rows, so a change made during the read is read again, never
  // missed.
  async changeTrackingPosition(table: SqlServerTable): Promise<ChangePosition> {
    const [[version, generation] = []] = await query(
      this.#pool.request(),
      `SELECT CONVERT(varchar(20), CHANGE_TRACKING_CURRENT_VERSION()), ${generationQuery}`,
      [table.quoted],
    );
    if (version === null || generation === null)
      throw new TypeError(
        `Change Tracking is off for ${table.quoted} in ${this.#location}`,
      );
    return Object.freeze({
      version: cellText(version, 'change tracking version'),
      generation: cellText(generation, 'change tracking generation'),
    });
  }

  // Rows below this rowversion are committed; one at or above it may belong
  // to a transaction still open, so a read stops short of it.
  async minActiveRowversion(): Promise<string> {
    const [[value] = []] = await query(
      this.#pool.request(),
      'SELECT CONVERT(varchar(20), CAST(MIN_ACTIVE_ROWVERSION() AS bigint))',
    );
    return cellText(value, 'MIN_ACTIVE_ROWVERSION');
  }

  // Up to limit rows in primary key order, after the given position. The
  // whole key compares as a tuple, each part cast to its column's type, so
  // pages neither skip nor repeat rows that share a leading key value.
  async *page(
    table: SqlServerTable,
    after: readonly string[] | null,
    limit: number,
  ): AsyncGenerator<SqlServerRow> {
    if (!table.pageable)
      throw new TypeError(
        `${table.quoted} has no primary key a read can page by`,
      );
    const keys = table.primaryKey;
    const key = (index: number) => `t.${keys[index]?.quoted}`;
    const cast = (index: number) => keys[index]?.codec.cast(`@p${index}`);
    const where =
      after === null
        ? ''
        : `WHERE ${keys
            .map(
              (_, index) =>
                `(${[
                  ...keys
                    .slice(0, index)
                    .map((__, prior) => `${key(prior)} = ${cast(prior)}`),
                  `${key(index)} > ${cast(index)}`,
                ].join(' AND ')})`,
            )
            .join(' OR ')}`;
    yield* this.#rows(
      table,
      `SELECT TOP (${count(limit)}) ${selection(table)} FROM ${table.quoted} AS t ${where} ORDER BY ${keys.map((_, index) => key(index)).join(', ')}`,
      after ?? [],
    );
  }

  // Up to limit rows whose rowversion is above `above` and below `below`, in
  // rowversion order.
  async *rowversions(
    table: SqlServerTable,
    above: string,
    below: string,
    limit: number,
  ): AsyncGenerator<SqlServerRow> {
    const column = table.rowversion;
    if (column === undefined)
      throw new TypeError(`${table.quoted} has no rowversion column`);
    const version = `t.${column.quoted}`;
    yield* this.#rows(
      table,
      `SELECT TOP (${count(limit)}) ${selection(table)} FROM ${table.quoted} AS t WHERE ${version} > ${column.codec.cast('@p0')} AND ${version} < ${column.codec.cast('@p1')} ORDER BY ${version}`,
      [above, below],
    );
  }

  // Every row, in no particular order.
  async *rows(table: SqlServerTable): AsyncGenerator<SqlServerRow> {
    yield* this.#rows(
      table,
      `SELECT ${selection(table)} FROM ${table.quoted} AS t`,
      [],
    );
  }

  // What changed in the table since a position in its change history: each
  // changed key once, with its row as it is now, or as a deletion. A position
  // from another generation, or outside the history kept, has expired. With
  // snapshot isolation the version, the check and the changes come from one
  // snapshot. Without it the version is read first, so a change made during
  // the read is read again next time, and the check runs again after the
  // read in case cleanup removed history meanwhile.
  async changes(
    table: SqlServerTable,
    since: ChangePosition,
  ): Promise<ChangeSet> {
    if (table.primaryKey.length === 0)
      throw new TypeError(
        `${table.quoted} has no primary key to track changes by`,
      );
    const transaction = this.#snapshot
      ? new sql.Transaction(this.#pool)
      : undefined;
    await transaction?.begin(sql.ISOLATION_LEVEL.SNAPSHOT);
    let open = transaction !== undefined;
    const close = async () => {
      if (!open) return;
      open = false;
      await transaction?.rollback();
    };
    const request = () =>
      transaction === undefined
        ? this.#pool.request()
        : new sql.Request(transaction);
    const check = async () => {
      const [[current, minimum, viewable, generation] = []] = await query(
        request(),
        `SELECT CONVERT(varchar(20), CHANGE_TRACKING_CURRENT_VERSION()), CONVERT(varchar(20), CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(@p0))), HAS_PERMS_BY_NAME(@p0, 'OBJECT', 'VIEW CHANGE TRACKING'), ${generationQuery}`,
        [table.quoted],
      );
      // Without the grant SQL Server still reports a minimum valid version
      // (0), so the grant itself is checked first.
      if (viewable !== 1)
        throw new SqlServerPermissionError(
          `VIEW CHANGE TRACKING ON ${table.quoted}`,
        );
      if (minimum === null || generation === null)
        throw new TypeError(`Change Tracking is off for ${table.quoted}`);
      const version = cellText(current, 'change tracking version');
      if (
        generation !== since.generation ||
        BigInt(since.version) <
          BigInt(cellText(minimum, 'minimum valid version')) ||
        BigInt(since.version) > BigInt(version)
      )
        throw new ChangeHistoryExpiredError(table.quoted, since.version);
      return version;
    };
    try {
      const version = await check();
      const keys = table.primaryKey;
      const present = `CASE WHEN t.${keys[0]?.quoted} IS NULL THEN 0 ELSE 1 END`;
      const changed = keys.flatMap((column) =>
        column.codec.select(`ct.${column.quoted}`),
      );
      const text = `DECLARE @since bigint = CAST(@p0 AS bigint);
SELECT ${present}, ${changed.join(', ')}, ${selection(table)}
FROM CHANGETABLE(CHANGES ${table.quoted}, @since) AS ct
LEFT JOIN ${table.quoted} AS t ON ${keys.map((column) => `t.${column.quoted} = ct.${column.quoted}`).join(' AND ')}`;
      const changes = async function* (): AsyncGenerator<SqlServerChange> {
        for await (const values of stream(request(), text, [since.version])) {
          const [exists] = values;
          const key = decode(keys, values.slice(1, 1 + changed.length));
          yield exists === 1
            ? {
                type: 'upsert',
                row: new SqlServerRow(
                  table,
                  decode(table.columns, values.slice(1 + changed.length)),
                ),
              }
            : { type: 'delete', key };
        }
        if (transaction === undefined) await check();
        else {
          open = false;
          await transaction.commit();
        }
      };
      // A read stopped early, or failed, leaves the snapshot to roll back.
      return new ChangeSet(
        Object.freeze({ version, generation: since.generation }),
        changes(),
        close,
      );
    } catch (error) {
      await close();
      throw error;
    }
  }

  async *#rows(
    table: SqlServerTable,
    text: string,
    parameters: readonly string[],
  ): AsyncGenerator<SqlServerRow> {
    for await (const values of stream(this.#pool.request(), text, parameters))
      yield new SqlServerRow(table, decode(table.columns, values));
  }
}

function trackingState(value: string): ChangeTracking {
  if (value === 'off' || value === 'readable' || value === 'denied')
    return value;
  throw new TypeError(`Unknown Change Tracking state ${value}`);
}

function count(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError(`A page holds at least one row, not ${limit}`);
  return limit;
}

// The expressions that read every column exactly, in column order.
function selection(table: SqlServerTable): string {
  return table.columns
    .flatMap((column) => column.codec.select(`t.${column.quoted}`))
    .join(', ');
}

// Each column's value from the expressions its codec selected.
function decode(
  columns: readonly SqlServerColumn[],
  values: readonly unknown[],
): SqlServerValue[] {
  let offset = 0;
  return columns.map(({ codec }) => {
    const width = codec.select('x').length;
    const value = codec.decode(values.slice(offset, offset + width));
    offset += width;
    return value;
  });
}

function groupBy(rows: readonly unknown[][]): Map<number, unknown[][]> {
  const groups = new Map<number, unknown[][]>();
  for (const row of rows) {
    const id = cellNumber(row[0], 'object_id');
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return groups;
}
