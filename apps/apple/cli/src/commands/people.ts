import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import type { Command as Declaration } from 'commander';

import { peopleConnectors, peopleFile } from '@workspace/apple-people/people';

import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

// Everyone but the user, the most recent first.
const everyone =
  'SELECT name, tags, first_at, last_at FROM people WHERE NOT is_self ORDER BY last_at DESC';

// Copied from query.ts (strike 2; see docs/copied-statement-runner.md): one
// statement, read-only; SQLite would otherwise run the first statement and
// silently drop the rest.
function query(
  database: DatabaseSync,
  sql: string,
): {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
} {
  const statement = database.prepare(sql);
  if (holdsStatement(database, sql.slice(statement.sourceSQL.length)))
    throw new Error('Run one SQL statement at a time');
  statement.setReturnArrays(true);
  return {
    columns: statement.columns().map(({ name }) => name),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- @types/node types rows as objects even though setReturnArrays(true) makes them arrays
    rows: statement.all() as unknown as unknown[][],
  };
}

// Copied from query.ts with query() above.
function holdsStatement(database: DatabaseSync, rest: string): boolean {
  try {
    database.prepare(rest);
    return true;
  } catch (error) {
    return Object(error).code !== 'ERR_INVALID_ARG_VALUE';
  }
}

// The people model: everyone the user dealt with in the connected apps, which
// people.sql builds on read from the counterparts of the imports it names,
// each attached under its connector's name.
export class PeopleCommand extends Command {
  readonly name = 'people';
  readonly summary =
    'List everyone you dealt with in the connected apps, tagged by how, or run one read-only SQL statement on them';

  protected configure(declaration: Declaration): void {
    declaration.argument(
      '[sql]',
      `one statement over the people, person_relations and person_identifiers views, which the comments of ${peopleFile} describe; without one, everyone but you, the most recent first`,
    );
  }

  protected async run(declaration: Declaration): Promise<Output> {
    const sql: string = declaration.processedArgs[0] ?? everyone;
    using database = this.imports.attach(peopleConnectors);
    try {
      database.exec(readFileSync(peopleFile, 'utf8'));
    } catch (error) {
      throw new Error(`The people model ${peopleFile} does not load`, {
        cause: error,
      });
    }
    const { columns, rows } = query(database, sql);
    return {
      data: rows.map((row) =>
        Object.fromEntries(columns.map((name, at) => [name, row[at]])),
      ),
      text: () =>
        `${table(columns, rows)}\n${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`,
    };
  }
}
