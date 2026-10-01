import { AppleCalendarSource } from 'apple/sources/apple-calendar/apple-calendar-source';
import type { ImportScope } from 'import-store';
import { AppleApp } from './apple-app.ts';
import { accounts, type Choice, collections, name } from './choice.ts';

export class CalendarApp extends AppleApp {
  readonly name = 'calendar';
  readonly title = 'Calendar';
  readonly datedBy = 'event dates';
  protected readonly choices: readonly Choice[] = [
    accounts(name),
    collections('calendars', 'calendars'),
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(terminal: string): string {
    return `Allow ${terminal} full Calendar access when macOS asks, or in System Settings › Privacy & Security › Calendars.`;
  }

  // Calendar reads occurrences within a window; without one, every event
  // from 2000 to a year ahead.
  protected source(scope: ImportScope) {
    return new AppleCalendarSource({
      startAt: scope.startAt ?? '2000-01-01T00:00:00.000Z',
      endAt:
        scope.endAt ??
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      scope,
      // Remote attachments stay links: downloading them needs Google sign-in.
      attachments: async () => false,
    });
  }
}
