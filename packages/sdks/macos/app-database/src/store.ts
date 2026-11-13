// A store that an SDK reads: the name its errors give it, and what the user
// does for each reason that it cannot be read (empty when nothing helps).
export class Store {
  readonly name: string;
  // The store is not there: what makes its app create it.
  readonly missing: string;
  // The system keeps the process from the store: the grant to give.
  readonly denied: string;

  constructor(
    name: string,
    remedies: { readonly missing: string; readonly denied: string },
  ) {
    this.name = name;
    this.missing = remedies.missing;
    this.denied = remedies.denied;
  }
}
