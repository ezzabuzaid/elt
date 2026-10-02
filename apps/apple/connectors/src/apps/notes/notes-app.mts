import type { ImportScope } from '@workspace/import-store';

import { AppleNotesSource } from '../../sources/apple-notes/apple-notes-source.ts';
import { AppleApp } from '../apple-app.ts';
import { type Choice, accounts, collections, name } from '../choice.ts';

export default class NotesApp extends AppleApp {
  readonly name = 'notes';
  readonly title = 'Notes';
  readonly datedBy = 'date last edited';
  readonly fullDiskAccess = true;
  override readonly note =
    'Exact containing folders; select descendants separately. Smart folders are saved searches and cannot be selected as containing folders.';
  protected readonly choices: readonly Choice[] = [
    accounts(name),
    collections('folders', 'folders'),
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Open Notes to let it finish syncing iCloud changes.';
  }

  protected source(scope: ImportScope) {
    return new AppleNotesSource({ scope });
  }
}
