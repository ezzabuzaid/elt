import { mkdtempDisposable, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { CopyConfiguration } from 'elt';
import { MarkdownDocument } from './markdown-document.ts';
import type { MarkdownFile } from './markdown-file.ts';
import { MarkdownWriter } from './markdown-writer.ts';

export class MarkdownFileWriter extends MarkdownWriter {
  constructor(
    configuration: CopyConfiguration,
    path: string,
    readonly target: MarkdownFile,
  ) {
    super(configuration, path, target.document);
    Object.freeze(this);
  }

  protected override get name(): string {
    return this.target.name;
  }

  protected override async read() {
    const path = join(this.path, this.target.name);
    if (!(await this.assertManagedFile(path))) return { rows: [] };
    const existing = await readFile(path, 'utf8');
    return {
      owner: MarkdownDocument.writer(existing),
      rows: MarkdownDocument.records(existing),
    };
  }

  protected override async publish(
    rows: readonly unknown[],
    writer: string,
  ): Promise<void> {
    const { stream, target } = this;
    const path = join(this.path, target.name);
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
    await this.assertManagedFile(path);
    await rename(stagedPath, path);
  }
}
