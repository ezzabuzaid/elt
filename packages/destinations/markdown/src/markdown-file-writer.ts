import { mkdtempDisposable, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import type { CopyConfiguration } from '@workspace/elt';

import { MarkdownDocument } from './markdown-document.ts';
import type { MarkdownFile } from './markdown-file.ts';
import { MarkdownWriter } from './markdown-writer.ts';

export class MarkdownFileWriter extends MarkdownWriter {
  readonly target: MarkdownFile;

  constructor(
    configuration: CopyConfiguration,
    path: string,
    target: MarkdownFile,
  ) {
    super(configuration, path, target.document);
    this.target = target;
    Object.freeze(this);
  }

  protected override get name(): string {
    return this.target.name;
  }

  protected override async read(name: string) {
    const path = join(this.path, name);
    if (!(await this.assertManagedFile(path))) return { rows: [] };
    const existing = await readFile(path, 'utf8');
    return {
      owner: MarkdownDocument.writer(existing),
      rows: MarkdownDocument.records(existing),
    };
  }

  protected override async publish(
    into: string,
    rows: readonly unknown[],
    writer: string,
  ): Promise<void> {
    const { stream, target } = this;
    await using staging = await mkdtempDisposable(
      join(this.path, '.markdown-'),
    );
    const stagedPath = join(staging.path, target.name);
    {
      await using file = await open(stagedPath, 'wx', 0o600);
      await file.writeFile(target.document.header(stream, writer));
      for (const [index, record] of rows.entries())
        await file.writeFile(target.document.render(record, index + 1));
    }
    await this.replace(stagedPath, join(this.path, into));
  }

  protected override async replace(from: string, to: string): Promise<void> {
    await this.assertManagedFile(to);
    await rename(from, to);
  }
}
