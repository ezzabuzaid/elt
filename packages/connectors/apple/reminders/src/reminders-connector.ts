import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import {
  type Choice,
  accounts,
  collections,
  name,
} from '@workspace/connector-apple-connector/choice';
import { RemindersStore } from '@workspace/sdk-apple-eventkit';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { AppleRemindersSource } from '@workspace/source-apple-reminders/apple-reminders-source';

export default class RemindersConnector extends AppleConnector {
  readonly datedBy = null;
  readonly fullDiskAccess = false;
  protected readonly choices: readonly Choice[] = [
    accounts(name),
    collections('lists', 'lists'),
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(grantee: string): string {
    return `Allow ${grantee} full Reminders access when macOS asks, or in System Settings › Privacy & Security › Reminders.`;
  }

  protected source(scope: ImportScope) {
    return new AppleRemindersSource({
      store: new RemindersStore(this.host.eventKitHelper),
      scope,
    });
  }
}
