import type { ImportScope } from 'import-store';
import { AppleContactsSource } from '../sources/apple-contacts/apple-contacts-source.ts';
import { AppleApp } from './apple-app.ts';
import { byId, type Choice, name } from './choice.ts';

export class ContactsApp extends AppleApp {
  readonly name = 'contacts';
  readonly title = 'Contacts';
  readonly datedBy = null;
  readonly fullDiskAccess = false;
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

  protected access(grantee: string): string {
    return `Allow ${grantee} when macOS asks for Contacts access, or turn it on in System Settings › Privacy & Security › Contacts. Full Disk Access for ${grantee} also works.`;
  }

  protected source(scope: ImportScope) {
    return new AppleContactsSource(undefined, scope);
  }
}
