import type { ImportScope } from 'import-store';
import { AppleMessagesSource } from '../sources/apple-messages/apple-messages-source.ts';
import { AppleApp } from './apple-app.ts';
import type { Choice } from './choice.ts';

export class MessagesApp extends AppleApp {
  readonly name = 'messages';
  readonly title = 'Messages';
  readonly datedBy = 'message date';
  readonly fullDiskAccess = true;
  protected readonly choices: readonly Choice[] = [
    {
      stream: 'chats',
      scope: 'collectionIds',
      title: 'chats',
      id: (row) => String(row.guid),
      label: (row) => String(row.displayName || row.chatIdentifier),
    },
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Only messages synced to this Mac can be imported.';
  }

  protected source(scope: ImportScope) {
    return new AppleMessagesSource(undefined, scope);
  }
}
