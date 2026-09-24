import type { SchemaRecord } from 'elt';
import { AppleNotesStream, notesSchema } from './apple-notes-stream.ts';

const properties = {
  id: { type: 'string' },
  name: { type: 'string' },
  // The container is a folder.
  containerId: { type: 'string' },
  body: { type: ['string', 'null'] },
  plaintext: { type: ['string', 'null'] },
  createdAt: { type: 'string', format: 'date-time' },
  modifiedAt: { type: 'string', format: 'date-time' },
  passwordProtected: { type: 'boolean' },
  shared: { type: 'boolean' },
} as const;

export type Note = SchemaRecord<typeof properties>;

export class NotesStream extends AppleNotesStream<typeof properties> {
  readonly name = 'notes';
  override readonly supportedSyncModes = Object.freeze([
    'full_refresh',
    'incremental',
  ] as const);
  readonly jsonSchema = notesSchema(properties);

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
}
