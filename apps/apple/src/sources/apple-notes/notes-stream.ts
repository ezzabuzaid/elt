import { isTimestamp } from 'elt';
import { AppleNotesStream } from './apple-notes-stream.ts';

export type Note = {
  id: string;
  name: string;
  // The container is a folder.
  containerId: string;
  body: string | null;
  plaintext: string | null;
  createdAt: string;
  modifiedAt: string;
  passwordProtected: boolean;
  shared: boolean;
};

export class NotesStream extends AppleNotesStream<Note> {
  readonly name = 'notes';
  override readonly supportedSyncModes = Object.freeze([
    'full_refresh',
    'incremental',
  ] as const);
  readonly jsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      containerId: { type: 'string' },
      body: { type: ['string', 'null'] },
      plaintext: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      modifiedAt: { type: 'string', format: 'date-time' },
      passwordProtected: { type: 'boolean' },
      shared: { type: 'boolean' },
    },
    required: [
      'id',
      'name',
      'containerId',
      'body',
      'plaintext',
      'createdAt',
      'modifiedAt',
      'passwordProtected',
      'shared',
    ],
  } as const;

  protected readonly script = `
      app.notes().map(note => {
        const passwordProtected = note.passwordProtected();
        return {
          id: note.id(),
          name: note.name(),
          containerId: note.container().id(),
          // Omit protected content even if the note is currently unlocked.
          body: passwordProtected ? null : note.body(),
          plaintext: passwordProtected ? null : note.plaintext(),
          createdAt: note.creationDate().toISOString(),
          modifiedAt: note.modificationDate().toISOString(),
          passwordProtected,
          shared: note.shared()
        };
      })
  `;

  protected validate(notes: unknown): Note[] {
    if (
      !Array.isArray(notes) ||
      !notes.every(
        (note) =>
          note !== null &&
          typeof note === 'object' &&
          !Array.isArray(note) &&
          typeof note.id === 'string' &&
          typeof note.name === 'string' &&
          typeof note.containerId === 'string' &&
          (note.body === null || typeof note.body === 'string') &&
          (note.plaintext === null || typeof note.plaintext === 'string') &&
          isTimestamp(note.createdAt) &&
          isTimestamp(note.modifiedAt) &&
          typeof note.passwordProtected === 'boolean' &&
          typeof note.shared === 'boolean',
      )
    )
      throw new TypeError('Notes returned an unexpected note format');

    return notes;
  }
}
