import type { Grant } from './macos-access.ts';

// A store that an SDK reads: the name its errors give it, what makes its app
// create it when it is not there (empty when nothing helps), and the grant
// that opens it, when macOS keeps it behind one.
export class Store {
  readonly name: string;
  readonly missing: string;
  readonly grant: Grant | undefined;

  constructor(
    name: string,
    remedies: { readonly missing: string; readonly grant?: Grant },
  ) {
    this.name = name;
    this.missing = remedies.missing;
    this.grant = remedies.grant;
  }
}
