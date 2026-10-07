import { Identifiers } from '@workspace/elt';

// SQLite holds a name of any length and compares two without ASCII case: it
// folds A-Z only, so `É` and `é` stay two names.
class SQLiteIdentifiers extends Identifiers {
  protected readonly maxBytes = Infinity;
  protected readonly ownColumns = ['loaded_at'];

  key(name: string): string {
    return name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
  }
}

export const identifiers = Object.freeze(new SQLiteIdentifiers());
