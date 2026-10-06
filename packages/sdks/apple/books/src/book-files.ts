import { writeEpub } from './epub-package.ts';
import { type LocalFile, localFiles } from './icloud-files.ts';

export const bookFileFormats = ['epub-package', 'file'] as const;
export type BookFileFormat = (typeof bookFileFormats)[number];

// A library asset's file: a single file such as a PDF or a zipped .epub, or
// an unzipped EPUB package directory, with what of it is on this Mac.
export type BookFile = {
  readonly assetId: string;
  readonly path: string;
  readonly format: BookFileFormat;
  // Whether its exportable form is on this Mac.
  readonly availableLocally: boolean;
  readonly fileCount: number | null;
  readonly sizeBytes: number | null;
  readonly modifiedAt: Date | null;
};

// A local item is a single file when localFiles returns the item itself;
// otherwise it is a directory, exportable only as an EPUB package.
const single = (files: readonly LocalFile[]) =>
  files.length === 1 && files[0]?.name === '';

function exportable(
  path: string,
  files: readonly LocalFile[] | null,
): readonly LocalFile[] | null {
  if (files === null || single(files)) return files;
  return path.toLowerCase().endsWith('.epub') ? files : null;
}

export async function bookFile(
  assetId: string,
  path: string,
): Promise<BookFile> {
  const listed = await localFiles(path).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  const files = exportable(path, listed);
  return {
    assetId,
    path,
    format:
      listed === null
        ? path.toLowerCase().endsWith('.epub')
          ? 'epub-package'
          : 'file'
        : single(listed)
          ? 'file'
          : 'epub-package',
    availableLocally: files !== null,
    fileCount: files?.length ?? null,
    sizeBytes: files?.reduce((sum, file) => sum + file.size, 0) ?? null,
    modifiedAt:
      files === null || files.length === 0
        ? null
        : new Date(Math.max(...files.map((file) => file.modifiedMs))),
  };
}

// The book as one file: a single file as it is, or a package written as one
// .epub at epubTarget. Checked again here, so a file that became a
// placeholder since it was listed is not opened; null when it is not local.
export async function exportBookFile(
  path: string,
  epubTarget: string,
): Promise<string | null> {
  const files = exportable(path, await localFiles(path));
  if (files === null) return null;
  if (single(files)) return files[0]?.path ?? null;
  await writeEpub(files, epubTarget);
  return epubTarget;
}
