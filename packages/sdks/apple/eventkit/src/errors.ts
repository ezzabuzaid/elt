import { Calendars, Client, Reminders } from '@zukhruf/tcc';

export class CalendarUnavailableError extends Error {
  override name = 'CalendarUnavailableError';

  constructor(cause: unknown) {
    super(
      `Calendar requires full Calendar access. ${new Calendars().remedy(Client.responsibleFor(process.pid))} A sandbox can prevent access even when permission is granted.`,
      { cause },
    );
  }
}

export class RemindersUnavailableError extends Error {
  override name = 'RemindersUnavailableError';

  constructor(cause: unknown) {
    super(
      `Reminders requires full Reminders access. ${new Reminders().remedy(Client.responsibleFor(process.pid))} A sandbox can prevent access even when permission is granted.`,
      { cause },
    );
  }
}

export class IcsExportUnavailableError extends Error {
  override name = 'IcsExportUnavailableError';

  constructor(cause: unknown) {
    super(
      'This macOS version does not provide the private EventKit ICS export.',
      { cause },
    );
  }
}

export class EventKitChangingError extends Error {
  override name = 'EventKitChangingError';

  constructor(entity: string, attempts: number) {
    super(
      `EventKit ${entity} changed during each of ${attempts} consistent reads; run the export again when edits settle.`,
    );
  }
}
