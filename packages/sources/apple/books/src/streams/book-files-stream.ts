import { join } from 'node:path';

import type { RecordDraft, SchemaRecord } from '@workspace/elt';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import { writeEpub } from '../epub-package.ts';
import { type LocalFile, localFiles } from '../icloud-files.ts';

const { boolean, nullableInteger, nullableTimestamp } = booksFields;

const properties = {
  assetId: booksFields.assetId,
  path: {
    ...booksFields.text,
    description:
      'Where Books keeps the file on this Mac, usually in iCloud Drive. An EPUB is a package directory there.',
  },
  format: {
    ...booksFields.text,
    enum: ['epub-package', 'file'],
    description:
      "epub-package: an unzipped EPUB directory, exported as one .epub file; file: a single file such as a PDF or a zipped .epub, exported as it is. For a placeholder, read from the path's extension.",
  },
  availableLocally: {
    ...boolean,
    description:
      "Whether the book's exportable file is wholly on this Mac. False for an iCloud Drive placeholder, which the export never opens, a missing path, or a directory that is not an EPUB package.",
  },
  fileCount: {
    ...nullableInteger,
    description:
      'Files in the package, or 1 for a single file; NULL when not available locally.',
  },
  sizeBytes: {
    ...nullableInteger,
    description:
      'Total bytes on disk of the file or the package contents; NULL when not available locally.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description:
      'Latest modification time of the file or any file in the package; NULL when not available locally.',
  },
} as const;

type Row = {
  readonly assetId: string;
  readonly path: string;
  readonly format: 'epub-package' | 'file';
  // The item's files when its exportable form is on this Mac; null otherwise.
  readonly files: readonly LocalFile[] | null;
};

// A local item is a single file when localFiles returns the item itself;
// otherwise it is a directory, exportable only as an EPUB package.
const single = (files: readonly LocalFile[]) =>
  files.length === 1 && files[0]?.name === '';

function exportable(
  path: string,
  files: readonly LocalFile[] | null,
): Row['files'] {
  if (files === null || single(files)) return files;
  return path.toLowerCase().endsWith('.epub') ? files : null;
}

export class BookFilesStream extends BooksStream<typeof properties, Row> {
  readonly name = 'bookFiles';
  readonly store = 'library';
  readonly primaryKey = ['assetId'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per library asset that has a file path, with the book file when its bytes are on this Mac. iCloud Drive placeholders are reported, never downloaded. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected async rows(scan: BooksScan): Promise<readonly Row[]> {
    const rows: Row[] = [];
    for (const row of scan.library.all(
      'SELECT ZASSETID, ZPATH FROM ZBKLIBRARYASSET WHERE ZASSETID IS NOT NULL AND ZPATH IS NOT NULL ORDER BY Z_PK',
    )) {
      // The query selects only rows whose ZASSETID and ZPATH are not null.
      const path = String(row.ZPATH);
      const files = await localFiles(path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      rows.push({
        assetId: String(row.ZASSETID),
        path,
        format:
          files === null
            ? path.toLowerCase().endsWith('.epub')
              ? 'epub-package'
              : 'file'
            : single(files)
              ? 'file'
              : 'epub-package',
        files: exportable(path, files),
      });
    }
    return rows;
  }

  protected record({
    assetId,
    path,
    format,
    files,
  }: Row): RecordDraft<typeof properties> {
    return {
      assetId,
      path,
      format,
      availableLocally: files !== null,
      fileCount: files?.length ?? null,
      sizeBytes: files?.reduce((sum, file) => sum + file.size, 0) ?? null,
      modifiedAt:
        files === null || files.length === 0
          ? null
          : new Date(
              Math.max(...files.map((file) => file.modifiedMs)),
            ).toISOString(),
    };
  }

  // A single file is exported as it is; a package is written as one .epub
  // under staging. Rechecked here, so a file that became a placeholder since
  // the scan is not opened.
  override async file(
    record: SchemaRecord<typeof properties>,
    _scan: BooksScan,
    staging: string,
  ): Promise<string | null> {
    if (!record.availableLocally) return null;
    const files = exportable(record.path, await localFiles(record.path));
    if (files === null) return null;
    if (single(files)) return files[0]?.path ?? null;
    const target = join(staging, `${record.assetId}.epub`);
    await writeEpub(files, target);
    return target;
  }
}
