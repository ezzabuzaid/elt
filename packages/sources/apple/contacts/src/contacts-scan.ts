import type {
  AddressBook,
  AddressBookStore,
  StoredData,
} from '@workspace/sdk-apple-contacts';
import {
  type ImportScope,
  selected,
} from '@workspace/source-apple-macos/import-scope';

// What a container selection keeps in one store: its containers, the
// contacts and groups in them, and any record among those three.
export class ContactSelection {
  readonly #containers: ReadonlySet<string | null>;
  readonly #contacts: ReadonlySet<string | null>;
  readonly #groups: ReadonlySet<string | null>;

  constructor(store: AddressBookStore, collectionIds: readonly string[]) {
    this.#containers = new Set(
      store
        .containers()
        .filter((container) => selected(collectionIds, container.id))
        .map((container) => container.id),
    );
    this.#contacts = new Set(
      store
        .contacts()
        .filter((contact) =>
          this.#has(this.#containers, contact.values.container),
        )
        .map((contact) => contact.id),
    );
    this.#groups = new Set(
      store
        .groups()
        .filter((group) => this.#has(this.#containers, group.values.container))
        .map((group) => group.id),
    );
  }

  container(id: unknown): boolean {
    return this.#has(this.#containers, id);
  }

  contact(id: unknown): boolean {
    return this.#has(this.#contacts, id);
  }

  group(id: unknown): boolean {
    return this.#has(this.#groups, id);
  }

  record(id: unknown): boolean {
    return this.container(id) || this.contact(id) || this.group(id);
  }

  #has(ids: ReadonlySet<string | null>, id: unknown): boolean {
    return (typeof id === 'string' || id === null) && ids.has(id);
  }
}

// Images are staged from bytes a stream read, by contact and kind.
export const imageKey = (contactId: unknown, kind: unknown) =>
  JSON.stringify([contactId, kind]);

// One run's read of every account store: streams read through it, each
// store's selection is worked out once, and the images stream leaves its
// stored data here for the files the read hands over.
export class ContactsScan implements AsyncDisposable {
  readonly images = new Map<string, StoredData>();
  readonly #book: AddressBook;
  readonly #scope: ImportScope;
  readonly #selections = new Map<AddressBookStore, ContactSelection>();

  constructor(book: AddressBook, scope: ImportScope) {
    this.#book = book;
    this.#scope = scope;
  }

  get stores(): readonly AddressBookStore[] {
    return this.#book.stores;
  }

  // null when the import takes every container.
  selection(store: AddressBookStore): ContactSelection | null {
    const { collectionIds } = this.#scope;
    if (collectionIds === undefined) return null;
    let selection = this.#selections.get(store);
    if (selection === undefined) {
      selection = new ContactSelection(store, collectionIds);
      this.#selections.set(store, selection);
    }
    return selection;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#book[Symbol.asyncDispose]();
  }
}
