import { lstat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { errorMessage } from '../state/sync-history.ts';
import type { DocumentParser } from './document-parser.ts';
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

// The text of each file a copy stored, read by a DocumentParser, so readers
// can search attachments with SQL. A stored file's ref names its copy by the
// SHA-256 of its bytes, so the ref is both the key and the input, and rows of
// different tables that hold one file share its text.
export class DocumentText extends Rule<string, typeof columns> {
  override readonly key = {
    name: 'ref',
    description:
      "Path of the stored copy, relative to the import's files folder: the value of the file column of every row whose file it is. Join that column to it.",
  };
  override readonly output = columns;
  // One file per call, as many at once as the Mac has cores; an image read
  // beyond the OCR workers waits in the host's pool.
  override readonly batch = 1;
  override readonly concurrency = availableParallelism();
  readonly #parser: () => DocumentParser;
  readonly #files: string;
  readonly #column: string;

  // parser: asked once per refresh, so a host's changed choice, such as a
  // speech model, applies from the next refresh. files: the folder the
  // column's refs are relative to.
  constructor({
    parser,
    files,
    column,
  }: {
    parser: () => DocumentParser;
    files: string;
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

  override identity(ref: string): Promise<string | null> {
    return this.#parser().identityFor(join(this.#files, ref));
  }

  override async compute(
    refs: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly RuleResult<RuleValues<typeof columns>>[]> {
    const parser = this.#parser();
    return Promise.all(
      refs.map(async (ref): Promise<RuleResult<RuleValues<typeof columns>>> => {
        const file = join(this.#files, ref);
        try {
          const content = await parser.parse(file, signal);
          return content === null ? { empty: true } : { value: { content } };
        } catch (failure) {
          if (
            signal?.aborted ||
            (Error.isError(failure) && failure.name === 'AbortError')
          )
            return { gone: true };
          // A missing file fails its row, also when a commit removed its
          // rows and the file after the refresh listed them: that commit asks
          // for the next refresh, which removes the row. A files folder that
          // never had the file, such as the disk of a new host, cannot give
          // it back, so the error says how to store it again.
          if (await missing(file))
            return {
              error: `The files folder ${this.#files} has no file ${ref}. Reload the copy that stored it to store the file again.`,
            };
          return { error: errorMessage(failure) };
        }
      }),
    );
  }
}

async function missing(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return true;
      throw error;
    },
  );
}
