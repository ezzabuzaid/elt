import { AppleNotesSource } from 'apple/sources/apple-notes/apple-notes-source';
import type { ImportScope } from 'apple/sources/import-scope';
import { AppleApp } from './apple-app.ts';
import { accounts, type Choice, collections, name } from './choice.ts';

export class NotesApp extends AppleApp {
  readonly name = 'notes';
  readonly title = 'Notes';
  readonly datedBy = 'date last edited';
  protected readonly choices: readonly Choice[] = [
    accounts(name),
    collections('folders', 'folders'),
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(terminal: string): string {
    return this.fullDiskAccess(terminal);
  }

  protected source(scope: ImportScope) {
    return new AppleNotesSource({ scope });
  }
}
