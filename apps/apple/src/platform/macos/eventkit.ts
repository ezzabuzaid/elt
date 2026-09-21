import osa from './osa.ts';

export class CalendarUnavailableError extends Error {
  override name = 'CalendarUnavailableError';

  constructor(cause: unknown) {
    super(
      'Calendar requires macOS 14 or later and full Calendar access for the process running the export. Allow access in System Settings > Privacy & Security > Calendars. A sandbox can prevent access even when permission is granted.',
      { cause },
    );
  }
}

export class RemindersUnavailableError extends Error {
  override name = 'RemindersUnavailableError';

  constructor(cause: unknown) {
    super(
      'Reminders requires macOS 14 or later and full Reminders access for the process running the export. Allow access in System Settings > Privacy & Security > Reminders. A sandbox can prevent access even when permission is granted.',
      { cause },
    );
  }
}

export class EventKit {
  static readonly runtime = `
ObjC.import('EventKit');
ObjC.import('AppKit');
ObjC.import('CoreLocation');

function requireEventKitAccess(store, entityType, marker) {
  const method = entityType === 0
    ? 'requestFullAccessToEventsWithCompletion'
    : 'requestFullAccessToRemindersWithCompletion';
  if (!store.respondsToSelector(method + ':'))
    throw new Error(marker + ': macOS 14 or later is required');
  const authorization = () => Number($.EKEventStore.authorizationStatusForEntityType(entityType));
  // The new authorization constants are absent from JXA BridgeSupport metadata.
  // 0=undetermined, 1=restricted, 2=denied, 3=full access, 4=write-only.
  if (authorization() === 0 || authorization() === 4) {
    store[method](() => {});
    const deadline = Date.now() + 30000;
    while ((authorization() === 0 || authorization() === 4) && Date.now() < deadline)
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  if (authorization() !== 3)
    throw new Error(marker + ': full access is required; status=' + authorization());
}
`;

  constructor(readonly entity: 'events' | 'reminders') {}

  async execute(script: string): Promise<unknown> {
    const entityType = this.entity === 'events' ? 0 : 1;
    const marker =
      this.entity === 'events'
        ? 'CALENDAR_UNAVAILABLE'
        : 'REMINDERS_UNAVAILABLE';
    let output: string;
    try {
      output = await osa.execute(`
        ${EventKit.runtime}
        const store = $.EKEventStore.alloc.init;
        requireEventKitAccess(store, ${entityType}, '${marker}');
        const value = (() => { ${script} })();
        if (Number($.EKEventStore.authorizationStatusForEntityType(${entityType})) !== 3)
          throw new Error('${marker}: access was revoked during execution');
        JSON.stringify(value);
      `);
    } catch (error) {
      if (
        error instanceof Error &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr.includes(marker)
      ) {
        const Unavailable =
          this.entity === 'events'
            ? CalendarUnavailableError
            : RemindersUnavailableError;
        throw new Unavailable(error);
      }
      throw error;
    }
    return JSON.parse(output);
  }
}
