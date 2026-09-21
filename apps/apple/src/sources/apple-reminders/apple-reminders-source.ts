import { Catalog } from 'elt';
import type { CopyConfiguration } from 'elt';
import { type RecordMessage, Source } from 'elt';
import { AccountsStream } from './accounts-stream.ts';
import { ListsStream } from './lists-stream.ts';
import { RemindersStream } from './reminders-stream.ts';

export class AppleRemindersSource extends Source {
  readonly identity = 'apple-reminders:local';
  readonly #readers = Object.freeze({
    accounts: new AccountsStream(),
    lists: new ListsStream(),
    reminders: new RemindersStream(),
  });
  readonly accounts = this.#readers.accounts.describe();
  readonly lists = this.#readers.lists.describe();
  readonly reminders = this.#readers.reminders.describe();
  readonly #catalog = new Catalog([this.accounts, this.lists, this.reminders]);

  constructor() {
    super();
    Object.freeze(this);
  }

  async discover(): Promise<Catalog> {
    return this.#catalog;
  }

  validate(configuration: CopyConfiguration): void {
    configuration.validate(this.#catalog.get(configuration.stream.name));
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    _state: unknown,
  ): AsyncGenerator<RecordMessage> {
    const reader = Object.values(this.#readers).find(
      (reader) => reader.name === configuration.stream.name,
    );
    if (!reader)
      throw new TypeError(`Unknown stream: ${configuration.stream.name}`);
    for await (const data of reader.read()) yield { stream: reader.name, data };
  }
}
