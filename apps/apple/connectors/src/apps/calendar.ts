import { GMAIL_READONLY_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE } from 'google-auth';
import type { ImportScope } from 'import-store';
import {
  AppleCalendarSource,
  type CalendarAttachmentFetcher,
} from '../sources/apple-calendar/apple-calendar-source.ts';
import { googleCalendarAttachments } from '../sources/apple-calendar/google-calendar-attachments.ts';
import { AppleApp } from './apple-app.ts';
import { accounts, type Choice, collections, name } from './choice.ts';

export class CalendarApp extends AppleApp {
  readonly name = 'calendar';
  readonly title = 'Calendar';
  readonly datedBy = 'event dates (events that overlap the range)';
  readonly fullDiskAccess = false;
  protected readonly choices: readonly Choice[] = [
    accounts(name),
    collections('calendars', 'calendars'),
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(grantee: string): string {
    return `Allow ${grantee} full Calendar access when macOS asks, or in System Settings › Privacy & Security › Calendars.`;
  }

  // Calendar reads occurrences within a window: every event from 2000 to a
  // year ahead.
  override defaultScope() {
    const end = new Date();
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    return { startAt: '2000-01-01T00:00:00.000Z', endAt: end.toISOString() };
  }

  // Listing calendars leaves remote attachments as links.
  protected source(scope: ImportScope) {
    return this.#calendar(scope, async () => false);
  }

  // An import downloads attachments stored in Google Drive and Gmail when
  // the host offers a Google session.
  protected override async importSource(scope: ImportScope) {
    if (this.host.google === undefined) return this.source(scope);
    const google = await this.host.google([
      GOOGLE_DRIVE_READONLY_SCOPE,
      GMAIL_READONLY_SCOPE,
    ]);
    return this.#calendar(scope, googleCalendarAttachments(google));
  }

  #calendar(scope: ImportScope, attachments: CalendarAttachmentFetcher) {
    const window = this.defaultScope();
    return new AppleCalendarSource({
      startAt: scope.startAt ?? window.startAt,
      endAt: scope.endAt ?? window.endAt,
      scope,
      attachments,
    });
  }
}
