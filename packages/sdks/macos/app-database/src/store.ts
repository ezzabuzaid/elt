import type { Service } from '@zukhruf/tcc';

// A store that an SDK reads: the name its errors give it, what makes its app
// create it when it is not there (empty when nothing helps), and the TCC
// service that opens it, when macOS keeps it behind one (@zukhruf/tcc).
export class Store {
  readonly name: string;
  readonly missing: string;
  readonly service: Service | undefined;

  constructor(
    name: string,
    remedies: { readonly missing: string; readonly service?: Service },
  ) {
    this.name = name;
    this.missing = remedies.missing;
    this.service = remedies.service;
  }
}
