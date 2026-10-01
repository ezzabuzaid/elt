import { AppleMessagesSource } from 'apple/sources/apple-messages/apple-messages-source';
import type { ImportScope } from 'apple/sources/import-scope';
import { AppleApp } from './apple-app.ts';
import type { Choice } from './choice.ts';

export class MessagesApp extends AppleApp {
  readonly name = 'messages';
  readonly title = 'Messages';
  readonly datedBy = 'message date';
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

  protected access(terminal: string): string {
    return this.fullDiskAccess(terminal);
  }

  protected source(scope: ImportScope) {
    return new AppleMessagesSource(undefined, undefined, scope);
  }
}
