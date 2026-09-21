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
    try {
      return JSON.parse(
        await osa.execute(
          this.script(`
        const value = (() => { ${script} })();
        if (Number($.EKEventStore.authorizationStatusForEntityType(entityType)) !== 3)
          throw new Error(marker + ': access was revoked during execution');
        JSON.stringify(value);
      `),
        ),
      );
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async *watch(signal: AbortSignal): AsyncGenerator<void> {
    try {
      for await (const message of osa.watch(
        this.script(`
        const center = $.NSNotificationCenter.defaultCenter;
        const changed = () => $.NSFileHandle.fileHandleWithStandardOutput.writeData(
          $('changed\\n').dataUsingEncoding($.NSUTF8StringEncoding));
        const observer = center.addObserverForNameObjectQueueUsingBlock(
          $.EKEventStoreChangedNotification, store, $.NSOperationQueue.mainQueue, changed);
        try {
          changed();
          $.NSRunLoop.currentRunLoop.run;
        } finally {
          center.removeObserver(observer);
        }
      `),
        signal,
      )) {
        if (message !== 'changed')
          throw new TypeError(
            'EventKit watcher returned an invalid notification',
          );
        yield;
      }
      if (!signal.aborted)
        throw new Error('EventKit watcher stopped unexpectedly');
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private script(script: string): string {
    const entityType = this.entity === 'events' ? 0 : 1;
    return `
        ${EventKit.runtime}
        const entityType = ${entityType};
        const marker = ${JSON.stringify(this.marker)};
        const store = $.EKEventStore.alloc.init;
        requireEventKitAccess(store, entityType, marker);
        ${script}
      `;
  }

  private get marker(): string {
    return this.entity === 'events'
      ? 'CALENDAR_UNAVAILABLE'
      : 'REMINDERS_UNAVAILABLE';
  }

  private unavailable(error: unknown): unknown {
    if (
      error instanceof Error &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr.includes(this.marker)
    ) {
      const Unavailable =
        this.entity === 'events'
          ? CalendarUnavailableError
          : RemindersUnavailableError;
      return new Unavailable(error);
    }
    return error;
  }
}
