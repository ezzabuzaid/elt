import { AppleContactsSource } from 'apple/sources/apple-contacts/apple-contacts-source';
import type { ImportScope } from 'apple/sources/import-scope';
import { AppleApp } from './apple-app.ts';
import { byId, type Choice, name } from './choice.ts';

export class ContactsApp extends AppleApp {
  readonly name = 'contacts';
  readonly title = 'Contacts';
  readonly datedBy = null;
  protected readonly choices: readonly Choice[] = [
    {
      stream: 'containers',
      scope: 'collectionIds',
      title: 'accounts',
      id: byId,
      label: name,
    },
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(terminal: string): string {
    return `Allow ${terminal} when macOS asks for Contacts access, or turn it on in System Settings › Privacy & Security › Contacts.`;
  }

  protected source(scope: ImportScope) {
    return new AppleContactsSource(undefined, undefined, scope);
  }
}
