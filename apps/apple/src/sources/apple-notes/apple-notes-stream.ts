import { Stream, type SyncMode } from 'elt';
import osa from '../../platform/macos/osa.ts';

export class NotesUnavailableError extends Error {
  override name = 'NotesUnavailableError';

  constructor(cause: unknown) {
    super(
      'Apple Notes is closed or inaccessible. Open Notes; if it is already open, run outside the sandbox that blocks macOS automation.',
      { cause },
    );
  }
}

// Internal extractor; public discovery returns only its Stream description.
export abstract class AppleNotesStream<T> {
  abstract readonly name: string;
  abstract readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly primaryKey = ['id'] as const;
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
  ]);
  protected abstract readonly script: string;
  protected abstract validate(records: unknown): T[];

  describe(): Stream {
    return new Stream(this);
  }

  async *read(): AsyncGenerator<T> {
    const records: unknown = JSON.parse(
      await this.execute(`JSON.stringify(${this.script});`),
    );
    yield* this.validate(records);
  }

  protected async execute(script: string): Promise<string> {
    try {
      return await osa.execute(`
        const app = Application('/System/Applications/Notes.app');
        if (!app.running()) throw new Error('NOTES_UNAVAILABLE');
        ${script}
      `);
    } catch (error) {
      if (
        error instanceof Error &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr.includes('NOTES_UNAVAILABLE')
      )
        throw new NotesUnavailableError(error);
      throw error;
    }
  }
}
