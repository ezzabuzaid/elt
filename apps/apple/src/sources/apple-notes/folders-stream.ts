import { AppleNotesStream } from './apple-notes-stream.ts';

export type Folder = {
  id: string;
  name: string;
  shared: boolean;
  // The container can be an account or another folder.
  containerId: string;
};

export class FoldersStream extends AppleNotesStream<Folder> {
  readonly name = 'folders';
  readonly jsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      shared: { type: 'boolean' },
      containerId: { type: 'string' },
    },
    required: ['id', 'name', 'shared', 'containerId'],
  } as const;

  protected readonly script = `
      app.folders().map(folder => ({
        id: folder.id(),
        name: folder.name(),
        shared: folder.shared(),
        containerId: folder.container().id()
      }))
  `;

  protected validate(folders: unknown): Folder[] {
    if (
      !Array.isArray(folders) ||
      !folders.every(
        (folder) =>
          folder !== null &&
          typeof folder === 'object' &&
          !Array.isArray(folder) &&
          typeof folder.id === 'string' &&
          typeof folder.name === 'string' &&
          typeof folder.shared === 'boolean' &&
          typeof folder.containerId === 'string',
      )
    )
      throw new TypeError('Notes returned an unexpected folder format');

    return folders;
  }
}
