import { AppleRemindersSource } from 'apple/sources/apple-reminders/apple-reminders-source';
import type { ImportScope } from 'import-store';
import { AppleApp } from './apple-app.ts';
import { accounts, type Choice, collections, name } from './choice.ts';

export class RemindersApp extends AppleApp {
  readonly name = 'reminders';
  readonly title = 'Reminders';
  readonly datedBy = null;
  protected readonly choices: readonly Choice[] = [
    accounts(name),
    collections('lists', 'lists'),
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(terminal: string): string {
    return `Allow ${terminal} full Reminders access when macOS asks, or in System Settings › Privacy & Security › Reminders.`;
  }

  protected source(scope: ImportScope) {
    return new AppleRemindersSource(scope);
  }
}
