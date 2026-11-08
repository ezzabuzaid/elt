import { Gauge } from '@zukhruf/async';

import type { WebInput } from './web-input.ts';

// The inputs of a web stream, as the host's function gives them now,
// sorted. A changed list is a change, so a watch reads the stream again and
// crawls an input that the host added from its start, as Nutch's generate
// round reads the injected URLs of the CrawlDb (elt ADR 0020).
export class InputList extends Gauge<readonly string[]> {
  readonly #inputs: () => ReadonlySet<WebInput>;

  constructor(inputs: () => ReadonlySet<WebInput>) {
    super();
    this.#inputs = inputs;
  }

  protected async read(): Promise<readonly string[]> {
    return [...this.#inputs()].toSorted();
  }
}
