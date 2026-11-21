import { availableParallelism } from 'node:os';
import { basename } from 'node:path';

import { errorMessage } from '../state/sync-history.ts';
import type { DocumentParser } from './document-parser.ts';
import { type FileStorage, StoredFileMissingError } from './file-storage.ts';
import {
  type LoadedRow,
  Rule,
  type RuleResult,
  type RuleValues,
} from './rule.ts';

const columns = {
  content: {
    type: 'text',
    description:
      'The text the parser extracted. NULL unless status is computed.',
  },
} as const;

// The text of each file a copy stored, read by a DocumentParser through the
// file storage that holds it, so readers can search attachments with SQL. A
// stored file's ref names its copy by the SHA-256 of its bytes, so the ref is
// both the key and the input, and rows of different tables that hold one file
// share its text.
export class DocumentText extends Rule<string, typeof columns> {
  override readonly key = {
    name: 'ref',
    description:
      'The ref of the stored file, as its file storage names it: the value of the file column of every row whose file it is. Join that column to it.',
  };
  override readonly output = columns;
  // One file per call, as many at once as the Mac has cores; an image read
  // beyond the OCR workers waits in the host's pool.
  override readonly batch = 1;
  override readonly concurrency = availableParallelism();
  readonly #parser: () => DocumentParser;
  readonly #files: FileStorage;
  readonly #column: string;

  // parser: asked once per refresh, so a host's changed choice, such as a
  // speech model, applies from the next refresh. files: the storage that
  // holds the files whose refs the column has.
  constructor({
    parser,
    files,
    column,
  }: {
    parser: () => DocumentParser;
    files: FileStorage;
    column: string;
  }) {
    super();
    this.#parser = parser;
    this.#files = files;
    this.#column = column;
    Object.freeze(this);
  }

  override read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: string } | null {
    const ref = row[this.#column];
    return typeof ref === 'string' ? { key: ref, input: ref } : null;
  }

  // A file that the storage does not hold has no first bytes to identify it
  // by, so the parser itself names its row, and compute fails that row with
  // the storage's message.
  override async identity(ref: string): Promise<string | null> {
    const parser = this.#parser();
    try {
      return await parser.identityFor({
        name: basename(ref),
        head: (length) => this.#files.head(ref, length),
      });
    } catch (failure) {
      if (failure instanceof StoredFileMissingError) return parser.identity;
      throw failure;
    }
  }

  override async compute(
    refs: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly RuleResult<RuleValues<typeof columns>>[]> {
    const parser = this.#parser();
    return Promise.all(
      refs.map(async (ref): Promise<RuleResult<RuleValues<typeof columns>>> => {
        let opened;
        try {
          opened = await this.#files.open(ref, signal);
        } catch (failure) {
          if (stopped(failure, signal)) return { gone: true };
          // A file that the storage does not hold fails only its row, also
          // when a commit removed its rows and the file after the refresh
          // listed them: that commit asks for the next refresh, which removes
          // the row. Each other failure of the storage, such as a folder that
          // this process may not read, fails the refresh.
          if (failure instanceof StoredFileMissingError)
            return { error: failure.message };
          throw failure;
        }
        await using file = opened;
        try {
          const content = await parser.parse(file.path, signal);
          return content === null ? { empty: true } : { value: { content } };
        } catch (failure) {
          if (stopped(failure, signal)) return { gone: true };
          return { error: errorMessage(failure) };
        }
      }),
    );
  }
}

function stopped(failure: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (Error.isError(failure) && failure.name === 'AbortError')
  );
}
