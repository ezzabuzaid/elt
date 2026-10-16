import { readFileSync } from 'node:fs';

import type { Command as Declaration } from 'commander';

import { peopleFile } from '@workspace/apple-people/people';
import { Federation } from '@workspace/sqlite-federation';

import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

// Everyone but the user, the most recent first.
const everyone =
  'SELECT name, tags, first_at, last_at FROM people WHERE NOT is_self ORDER BY last_at DESC';

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
      `one statement over the people, person_relations and person_identifiers views, which the comments of ${peopleFile} describe; qualify source tables as connector.view. Without a statement, everyone but you, the most recent first`,
    );
  }

  protected async run(declaration: Declaration): Promise<Output> {
    const sql: string = declaration.processedArgs[0] ?? everyone;
    using database = new Federation({
      main: ':memory:',
      locate: this.imports.locate,
      timeout: 30_000,
    });
    try {
      database.exec(readFileSync(peopleFile, 'utf8'));
    } catch (error) {
      throw new Error(`The people model ${peopleFile} does not load`, {
        cause: error,
      });
    }
    const { columns, rows } = database.query(sql);
    return {
      data: rows.map((row) =>
        Object.fromEntries(columns.map((name, at) => [name, row[at]])),
      ),
      text: () =>
        `${table(columns, rows)}\n${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`,
    };
  }
}
