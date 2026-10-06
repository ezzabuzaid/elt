import { join } from 'node:path';

import type { RecordDraft, SchemaRecord } from '@workspace/elt';
import {
  type BookFile,
  bookFileFormats,
  exportBookFile,
} from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

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
    enum: bookFileFormats,
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

export class BookFilesStream extends BooksStream<typeof properties, BookFile> {
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

  protected rows(scan: BooksScan): Promise<readonly BookFile[]> {
    return scan.library.bookFiles();
  }

  protected record(file: BookFile): RecordDraft<typeof properties> {
    return {
      assetId: file.assetId,
      path: file.path,
      format: file.format,
      availableLocally: file.availableLocally,
      fileCount: file.fileCount,
      sizeBytes: file.sizeBytes,
      modifiedAt: iso(file.modifiedAt),
    };
  }

  // A single file is exported as it is; a package is written as one .epub
  // under staging.
  override async file(
    record: SchemaRecord<typeof properties>,
    _scan: BooksScan,
    staging: string,
  ): Promise<string | null> {
    if (!record.availableLocally) return null;
    return exportBookFile(record.path, join(staging, `${record.assetId}.epub`));
  }
}
