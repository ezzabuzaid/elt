import type { SchemaRecord } from 'elt';
import { AppleNotesStream, notesSchema } from './apple-notes-stream.ts';

const properties = {
  id: { type: 'string' },
  name: { type: 'string' },
  shared: { type: 'boolean' },
  // The container can be an account or another folder.
  containerId: { type: 'string' },
} as const;

export type Folder = SchemaRecord<typeof properties>;

export class FoldersStream extends AppleNotesStream<typeof properties> {
  readonly name = 'folders';
  readonly jsonSchema = notesSchema(properties);

  protected readonly script = `
      app.folders().map(folder => ({
        id: folder.id(),
        name: folder.name(),
        shared: folder.shared(),
        containerId: folder.container().id()
      }))
  `;
}
