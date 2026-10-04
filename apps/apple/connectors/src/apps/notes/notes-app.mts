import { AppleApp } from '@workspace/connector-apple-app/apple-app';
import {
  type Choice,
  accounts,
  collections,
  name,
} from '@workspace/connector-apple-app/choice';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';

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
