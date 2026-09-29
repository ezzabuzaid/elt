import { join, resolve } from 'node:path';
import type { CopyConfiguration, Load } from 'elt';
import { Destination } from 'elt';
import { MarkdownFile } from './markdown-file.ts';
import { MarkdownFileWriter } from './markdown-file-writer.ts';
import { MarkdownFolder } from './markdown-folder.ts';
import { MarkdownFolderWriter } from './markdown-folder-writer.ts';
import type { MarkdownWriter } from './markdown-writer.ts';

export class MarkdownDestination extends Destination<
  MarkdownFile | MarkdownFolder
> {
  readonly supportedDestinationSyncModes = Object.freeze([
    'overwrite',
    'append',
    'append_dedup',
    'overwrite_dedup',
  ] as const);
  readonly path: string;

  constructor({ path }: { path: string }) {
    super();
    if (!path || path.includes('\0'))
      throw new TypeError('Markdown requires an output directory');
    this.path = resolve(path);
    Object.freeze(this);
  }

  override identity(target: MarkdownFile | MarkdownFolder): string {
    return JSON.stringify({ type: 'markdown', path: this.path, target });
  }

  override location(target: MarkdownFile | MarkdownFolder): string {
    return join(this.path, target.name);
  }

  override async load(): Promise<Load<MarkdownFile | MarkdownFolder>> {
    return {
      prepare: (configuration, target, binding) =>
        this.createWriter(configuration, target).prepare(binding),
      [Symbol.asyncDispose]: async () => {},
    };
  }

  file(
    name: string,
    options?: ConstructorParameters<typeof MarkdownFile>[1],
  ): MarkdownFile {
    return new MarkdownFile(name, options);
  }

  folder(
    name: string,
    options?: ConstructorParameters<typeof MarkdownFile>[1],
  ): MarkdownFolder {
    return new MarkdownFolder(name, options);
  }

  override createWriter(
    configuration: CopyConfiguration,
    target: MarkdownFile | MarkdownFolder,
  ): MarkdownWriter {
    this.validateConfiguration(configuration, target);
    if (target.fileReads.some((read) => read.outputType !== 'text'))
      throw new TypeError(
        'Markdown file fields require a document parser or file storage',
      );
    if (target instanceof MarkdownFolder)
      return new MarkdownFolderWriter(configuration, this.path, target);
    if (target instanceof MarkdownFile)
      return new MarkdownFileWriter(configuration, this.path, target);
    throw new TypeError('Markdown requires Markdown file or folder targets');
  }
}
