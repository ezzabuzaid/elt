import { lstat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import type { DocumentParser } from './document-parser.ts';
import { type LoadedRow, Rule, type RuleResult } from './rule.ts';

// The text of each file a copy stored, read by a DocumentParser, so readers
// can search attachments with SQL. A stored file's ref names its copy by the
// SHA-256 of its bytes, so the ref is both the key and the input, and rows of
// different tables that hold one file share its text.
export class DocumentText extends Rule<string, string> {
  override readonly key = {
    name: 'ref',
    description:
      "Path of the stored copy, relative to the import's files folder: the value of the file column of every row whose file it is. Join that column to it.",
  };
  override readonly output = {
    content: {
      type: 'text',
      description:
        'The text the parser extracted. NULL unless status is computed.',
    },
  } as const;
  // Files decode concurrently; an image read beyond the OCR workers waits in
  // the host's pool.
  override readonly batch = availableParallelism();
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
  ): Promise<readonly RuleResult<Readonly<Record<string, string>>>[]> {
    const parser = this.#parser();
    return Promise.all(
      refs.map(
        async (ref): Promise<RuleResult<Readonly<Record<string, string>>>> => {
          const file = join(this.#files, ref);
          try {
            const content = await parser.parse(file, signal);
            return content === null ? { empty: true } : { value: { content } };
          } catch (failure) {
            if (
              signal?.aborted ||
              (failure instanceof Error && failure.name === 'AbortError')
            )
              return { gone: true };
            // A commit removed the copy after the refresh listed it; its rows
            // are gone too, so the file is not a failure.
            if (await removed(file)) return { gone: true };
            return {
              error:
                failure instanceof Error ? failure.message : String(failure),
            };
          }
        },
      ),
    );
  }
}

async function removed(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return true;
      throw error;
    },
  );
}
