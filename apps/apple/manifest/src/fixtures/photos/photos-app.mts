import { AppleApp } from '@workspace/apple/apps/apple-app';
import type { Choice } from '@workspace/apple/apps/choice';
import type { Source } from '@workspace/elt';

// A connector outside the library, built on the same AppleApp extension point.
export default class PhotosApp extends AppleApp {
  readonly name = 'photos';
  readonly title = 'Photos';
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
