import type { EventKitDocument, ReminderDocument } from './documents.ts';
import { RemindersUnavailableError } from './errors.ts';
import {
  type Collections,
  type EventKitQuery,
  EventKitStore,
} from './eventkit-store.ts';

export type RemindersContents = Collections & {
  readonly reminders: readonly ReminderDocument[];
};

// Reminder lists, which EventKit calls calendars, and every reminder in them.
export class RemindersStore extends EventKitStore<
  EventKitQuery,
  RemindersContents
> {
  protected readonly entity = 'reminders';
  protected readonly accessMarker = 'REMINDERS_UNAVAILABLE';

  protected request() {
    return {};
  }

  protected contents(
    collections: Collections,
    documents: readonly EventKitDocument[],
  ): RemindersContents {
    return {
      ...collections,
      reminders: documents.filter((document) => document.type === 'reminder'),
    };
  }

  protected accessDenied(cause: unknown): Error {
    return new RemindersUnavailableError(cause);
  }
}
