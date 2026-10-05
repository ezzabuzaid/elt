import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import { AppleBooksSource } from '@workspace/source-apple-books/apple-books-source';

export default class BooksConnector extends AppleConnector {
  readonly datedBy = null;
  readonly fullDiskAccess = true;
  // Books' collections are built-in lists; everything is imported.
  protected readonly choices: readonly Choice[] = [];
  // Collections live in the library store every Books import reads.
  protected override readonly probe = 'collections';
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Books does not need to be open. Books stored only in iCloud are listed without their files; open them in Books to download them.';
  }

  protected source() {
    return new AppleBooksSource();
  }
}
