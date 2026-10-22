import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { AppleMessagesSource } from '@workspace/source-apple-messages/apple-messages-source';

export default class MessagesConnector extends AppleConnector {
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
