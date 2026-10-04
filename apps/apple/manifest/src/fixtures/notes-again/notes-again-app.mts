import { AppleApp } from '@workspace/connector-apple-app/apple-app';
import type { Choice } from '@workspace/connector-apple-app/choice';
import type { Source } from '@workspace/elt';

// A second connector named notes.
export default class NotesAgainApp extends AppleApp {
  readonly name = 'notes';
  readonly title = 'Notes again';
  readonly datedBy = 'date taken';
  readonly fullDiskAccess = true;
  protected readonly choices: readonly Choice[] = [];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Open Photos once.';
  }

  protected source(): Source {
    throw new Error('The Photos fixture reads nothing.');
  }
}
