import {
  AppleCalendarSource,
  type CalendarAttachmentFetcher,
} from 'apple/sources/apple-calendar/apple-calendar-source';
import { googleCalendarAttachments } from 'apple/sources/apple-calendar/google-calendar-attachments';
import {
  GMAIL_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  googleSession,
  grantDirectory,
} from 'google-auth';
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

  // Listing calendars leaves remote attachments as links.
  protected source(scope: ImportScope) {
    return this.#calendar(scope, async () => false);
  }

  // An import downloads attachments stored in Google Drive and Gmail.
  protected override async importSource(scope: ImportScope) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      throw new Error(
        `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for Calendar's Drive/Gmail attachments; grants are stored under ${grantDirectory()}.`,
      );
    const google = await googleSession({
      clientId,
      clientSecret,
      scopes: [GOOGLE_DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE],
    });
    return this.#calendar(scope, googleCalendarAttachments(google));
  }

  // Calendar reads occurrences within a window; without one, every event
  // from 2000 to a year ahead.
  #calendar(scope: ImportScope, attachments: CalendarAttachmentFetcher) {
    return new AppleCalendarSource({
      startAt: scope.startAt ?? '2000-01-01T00:00:00.000Z',
      endAt:
        scope.endAt ??
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      scope,
      attachments,
    });
  }
}
