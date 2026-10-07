import { Identifiers } from '@workspace/elt';

// Postgres keeps 63 bytes of a name and silently drops the rest, and refuses
// a column named like one of its system columns however it is quoted.
class PostgresIdentifiers extends Identifiers {
  protected readonly maxBytes = 63;
  protected readonly ownColumns = [
    'loaded_at',
    'tableoid',
    'cmax',
    'xmax',
    'cmin',
    'xmin',
    'ctid',
  ];

  // Quoted identifiers are case-sensitive.
  key(name: string): string {
    return name;
  }
}

export const identifiers = Object.freeze(new PostgresIdentifiers());
