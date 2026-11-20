import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

// SQL Server keeps at most 7,500 bytes in an extended property, and a value
// of nvarchar takes 2 bytes for each UTF-16 code unit.
const mostBytes = 7500;

// A target's descriptions as SQL Server keeps them: one MS_Description
// extended property on the table or its view, and one on each column, the
// property that SQL Server Management Studio and the SQL Server source of
// elt read. A null description removes the property.
export class TargetDescriptions {
  readonly #table: string;
  readonly #columns: Readonly<Record<string, string | null>>;

  constructor(table: string, columns: Readonly<Record<string, string | null>>) {
    for (const [name, description] of [
      ['the table', table],
      ...Object.entries(columns),
    ])
      if (description !== null && description.length * 2 > mostBytes)
        throw new TypeError(
          `The description of ${name} takes ${description.length * 2} bytes; a SQL Server extended property holds at most ${mostBytes}`,
        );
    this.#table = table;
    this.#columns = columns;
    Object.freeze(this);
  }

  async write(
    connection: SqlServerConnection,
    kind: 'TABLE' | 'VIEW',
    schema: string,
    name: string,
  ): Promise<void> {
    await connection.query(
      `DECLARE @object int = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@name));
       DECLARE @column sysname, @description nvarchar(4000), @level2 varchar(10), @has bit;
       DECLARE descriptions CURSOR LOCAL FAST_FORWARD FOR
         SELECT [column], [description] FROM OPENJSON(@descriptions) WITH ([column] sysname '$[0]', [description] nvarchar(4000) '$[1]');
       OPEN descriptions;
       FETCH NEXT FROM descriptions INTO @column, @description;
       WHILE @@FETCH_STATUS = 0
       BEGIN
         SET @level2 = IIF(@column IS NULL, NULL, 'COLUMN');
         SET @has = IIF(EXISTS (SELECT 1 FROM sys.extended_properties WHERE [class] = 1 AND [major_id] = @object
           AND [minor_id] = IIF(@column IS NULL, 0, COLUMNPROPERTY(@object, @column, 'ColumnId')) AND [name] = N'MS_Description'), 1, 0);
         IF @has = 1 AND @description IS NULL
           EXEC sp_dropextendedproperty N'MS_Description', 'SCHEMA', @schema, @kind, @name, @level2, @column;
         ELSE IF @has = 1
           EXEC sp_updateextendedproperty N'MS_Description', @description, 'SCHEMA', @schema, @kind, @name, @level2, @column;
         ELSE IF @description IS NOT NULL
           EXEC sp_addextendedproperty N'MS_Description', @description, 'SCHEMA', @schema, @kind, @name, @level2, @column;
         FETCH NEXT FROM descriptions INTO @column, @description;
       END;
       CLOSE descriptions;
       DEALLOCATE descriptions;`,
      {
        schema,
        name,
        kind,
        descriptions: JSON.stringify([
          [null, this.#table],
          ...Object.entries(this.#columns),
        ]),
      },
    );
  }
}
