import {
  type FieldSchema,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from 'elt';
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

type Properties = Readonly<Record<string, FieldSchema>>;

// Every Notes property is required; the record type follows from the schema.
export function notesSchema<P extends Properties>(properties: P) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
  } as const;
}

// Internal extractor; public discovery returns only its Stream description.
export abstract class AppleNotesStream<P extends Properties> {
  abstract readonly name: string;
  abstract readonly jsonSchema: ReturnType<typeof notesSchema<P>>;
  readonly primaryKey = ['id'] as const;
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
  ]);
  protected abstract readonly script: string;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  async *read(): AsyncGenerator<SchemaRecord<P>> {
    const records: unknown = JSON.parse(
      await this.execute(`JSON.stringify(${this.script});`),
    );
    yield* validateRecords(
      this.describe(),
      records,
      'Notes',
    ) as SchemaRecord<P>[];
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
