// Every selected stream's records, read in one change-free window.
export class CalendarSnapshot implements AsyncDisposable {
  readonly #records: ReadonlyMap<string, readonly Record<string, unknown>[]>;

  constructor(
    records: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  ) {
    this.#records = records;
  }

  of(stream: string): readonly Record<string, unknown>[] {
    const records = this.#records.get(stream);
    if (records === undefined)
      throw new TypeError(`Stream ${stream} was not read in this session`);
    return records;
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}
