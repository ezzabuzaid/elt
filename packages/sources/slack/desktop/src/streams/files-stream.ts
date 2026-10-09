import type { RecordDraft } from '@workspace/elt';
import type { SlackFile } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const {
  id,
  nullableText,
  nullableBoolean,
  nullableInteger,
  nullableTimestamp,
} = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  id: { ...id, description: 'Slack’s file ID, such as F0123ABCD.' },
  name: { ...nullableText, description: 'The file’s name.' },
  title: { ...nullableText, description: 'The title shown for it.' },
  mimetype: { ...nullableText, description: 'Its MIME type.' },
  filetype: {
    ...nullableText,
    description: 'Slack’s file type, such as pdf, png, markdown or list.',
  },
  prettyType: { ...nullableText, description: 'The type as Slack shows it.' },
  mode: {
    ...nullableText,
    description:
      'hosted (uploaded), external, snippet, post, canvas or list (a Slack List, its rows in list_records).',
  },
  size: { ...nullableInteger, description: 'Its size in bytes.' },
  userId: { ...nullableText, description: 'Who shared it (members.id).' },
  createdAt: { ...nullableTimestamp, description: 'When it was created.' },
  updatedAt: { ...nullableTimestamp, description: 'When it last changed.' },
  editedAt: { ...nullableTimestamp, description: 'When it was last edited.' },
  isExternal: {
    ...nullableBoolean,
    description: 'Whether it lives in another service.',
  },
  externalType: {
    ...nullableText,
    description: 'The service an external file lives in.',
  },
  isPublic: {
    ...nullableBoolean,
    description: 'Whether it is shared in a public channel.',
  },
  isDeleted: { ...nullableBoolean, description: 'Whether it was deleted.' },
  isTombstoned: {
    ...nullableBoolean,
    description: 'Whether Slack keeps only a placeholder of it.',
  },
  urlPrivate: {
    ...nullableText,
    description:
      'Its download address, which needs Slack’s sign-in; the app keeps no copy of the bytes.',
  },
  permalink: { ...nullableText, description: 'Its page in Slack.' },
  preview: {
    ...nullableText,
    description: 'The first lines of a text file or snippet.',
  },
  lines: { ...nullableInteger, description: 'A text file’s line count.' },
  durationMs: {
    ...nullableInteger,
    description: 'A recording’s length in milliseconds.',
  },
  width: { ...nullableInteger, description: 'An image or video’s width.' },
  height: { ...nullableInteger, description: 'An image or video’s height.' },
  listMetadata: {
    ...nullableText,
    description:
      'For a List, its columns (schema) and views as JSON, as Slack holds them.',
  },
  transcription: {
    ...nullableText,
    description: 'For a recording, its transcript as JSON.',
  },
} as const;

type Row = { readonly workspaceId: string; readonly file: SlackFile };

// The app keeps the files it loaded and drops them again; a deletion shows as
// isDeleted or isTombstoned while it still holds the file, so a file it
// drops stays.
export class FilesStream extends SlackDesktopStream<typeof properties, Row> {
  readonly name = 'files';
  readonly primaryKey = ['workspaceId', 'id'];
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per file the app has held: uploads, snippets, canvases and Lists, metadata only (the app keeps no bytes). Primary key workspaceId, id. A file stays after the app drops it from its cache; one deleted while held reads isDeleted or isTombstoned.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, files }) =>
      files.map((file) => ({ workspaceId: workspace.id, file })),
    );
  }

  protected records({
    workspaceId,
    file,
  }: Row): RecordDraft<typeof properties>[] {
    return [
      {
        workspaceId,
        id: file.id,
        name: file.name,
        title: file.title,
        mimetype: file.mimetype,
        filetype: file.filetype,
        prettyType: file.prettyType,
        mode: file.mode,
        size: file.size,
        userId: file.userId,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        editedAt: file.editedAt,
        isExternal: file.isExternal,
        externalType: file.externalType,
        isPublic: file.isPublic,
        isDeleted: file.isDeleted,
        isTombstoned: file.isTombstoned,
        urlPrivate: file.urlPrivate,
        permalink: file.permalink,
        preview: file.preview,
        lines: file.lines,
        durationMs: file.durationMs,
        width: file.width,
        height: file.height,
        listMetadata: file.listMetadataJson,
        transcription: file.transcriptionJson,
      },
    ];
  }
}
