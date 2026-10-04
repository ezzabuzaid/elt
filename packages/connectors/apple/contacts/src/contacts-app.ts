import { AppleApp } from '@workspace/connector-apple-app/apple-app';
import { type Choice, byId, name } from '@workspace/connector-apple-app/choice';
import { AppleContactsSource } from '@workspace/source-apple-contacts/apple-contacts-source';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

export default class ContactsApp extends AppleApp {
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
