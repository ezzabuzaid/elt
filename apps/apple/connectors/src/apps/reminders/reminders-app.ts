import type { ImportScope } from '@workspace/import-store';

import { AppleRemindersSource } from '../../sources/apple-reminders/apple-reminders-source.ts';
import { AppleApp } from '../apple-app.ts';
import { type Choice, accounts, collections, name } from '../choice.ts';

export default class RemindersApp extends AppleApp {
  readonly name = 'reminders';
  readonly title = 'Reminders';
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
    return new AppleRemindersSource(scope);
  }
}
