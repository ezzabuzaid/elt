import { Stream } from 'elt';
import osa from '../../platform/macos/osa.ts';

export class RemindersUnavailableError extends Error {
  override name = 'RemindersUnavailableError';

  constructor(cause: unknown) {
    super(
      'Apple Reminders is closed or inaccessible. Open Reminders; if it is already open, run outside the sandbox that blocks macOS automation.',
      { cause },
    );
  }
}

// Internal extraction; discovery exposes immutable Stream descriptions.
export abstract class AppleRemindersStream<T> {
  abstract readonly name: string;
  abstract readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly primaryKey = ['id'] as const;
  readonly supportedSyncModes = Object.freeze(['full_refresh'] as const);
  protected abstract readonly script: string;
  protected abstract validate(records: unknown): T[];

  describe(): Stream {
    return new Stream(this);
  }

  async *read(): AsyncGenerator<T> {
    let output: string;
    try {
      output = await osa.execute(`
        const app = Application('/System/Applications/Reminders.app');
        if (!app.running()) throw new Error('REMINDERS_UNAVAILABLE');
        JSON.stringify(${this.script});
      `);
    } catch (error) {
      if (
        error instanceof Error &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr.includes('REMINDERS_UNAVAILABLE')
      )
        throw new RemindersUnavailableError(error);
      throw error;
    }
    const records: unknown = JSON.parse(output);
    yield* this.validate(records);
  }
}
