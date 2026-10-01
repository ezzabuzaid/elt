import { AppleBooksSource } from 'apple/sources/apple-books/apple-books-source';
import { AppleApp } from './apple-app.ts';
import type { Choice } from './choice.ts';

export class BooksApp extends AppleApp {
  readonly name = 'books';
  readonly title = 'Books';
  readonly datedBy = null;
  // Books' collections are built-in lists; everything is imported.
  protected readonly choices: readonly Choice[] = [];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(terminal: string): string {
    return `${this.fullDiskAccess(terminal)} Books stored only in iCloud are listed without their files; open them in Books to download them.`;
  }

  protected source() {
    return new AppleBooksSource();
  }
}
