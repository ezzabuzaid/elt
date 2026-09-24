import type { SchemaRecord } from 'elt';
import { AppleNotesStream, notesSchema } from './apple-notes-stream.ts';

const properties = {
  id: { type: 'string' },
  name: { type: ['string', 'null'] },
  // The container is a note; optional file extraction travels outside this metadata.
  containerId: { type: 'string' },
  contentId: { type: ['string', 'null'] },
  url: { type: ['string', 'null'] },
  createdAt: { type: 'string', format: 'date-time' },
  modifiedAt: { type: 'string', format: 'date-time' },
  shared: { type: 'boolean' },
} as const;

export type Attachment = SchemaRecord<typeof properties>;

export class AttachmentsStream extends AppleNotesStream<typeof properties> {
  readonly name = 'attachments';
  readonly supportsFileTransfer = true;
  override readonly supportedSyncModes = Object.freeze([
    'full_refresh',
    'incremental',
  ] as const);
  readonly jsonSchema = notesSchema(properties);

  protected readonly script = `
      app.attachments().map(attachment => ({
        id: attachment.id(),
        name: attachment.name() ?? null,
        containerId: attachment.container().id(),
        contentId: attachment.contentIdentifier() ?? null,
        url: attachment.url() ?? null,
        createdAt: attachment.creationDate().toISOString(),
        modifiedAt: attachment.modificationDate().toISOString(),
        shared: attachment.shared()
      }))
  `;

  async save(id: string, path: string): Promise<boolean> {
    const exported: unknown = JSON.parse(
      await this.execute(`
      const attachment = app.attachments.byId(${JSON.stringify(id)});
      const hasFile = !attachment.container().passwordProtected() &&
        attachment.url() == null && attachment.contents() != null;
      if (hasFile) app.save(attachment, { in: Path(${JSON.stringify(path)}) });
      JSON.stringify(hasFile);
    `),
    );
    if (typeof exported !== 'boolean')
      throw new TypeError(
        'Notes returned an unexpected attachment export result',
      );
    return exported;
  }
}
