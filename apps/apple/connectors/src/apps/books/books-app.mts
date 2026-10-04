import { AppleBooksSource } from '@workspace/source-apple-books/apple-books-source';

import { AppleApp } from '../apple-app.ts';
import type { Choice } from '../choice.ts';

export default class BooksApp extends AppleApp {
  readonly name = 'books';
  readonly title = 'Books';
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
