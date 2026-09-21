import type { FileRead } from '../../core/file-read.ts';
import { Target } from '../../core/target.ts';
import { MarkdownDocument } from './markdown-document.ts';

// One stream becomes one document; each record becomes a section.
export class MarkdownFile extends Target {
  readonly name: string;
  readonly document: MarkdownDocument;

  constructor(
    name: string,
    options?: { title?: string; fields?: readonly FileRead[] },
  ) {
    if (!/^[a-z][a-z0-9_-]*\.md$/.test(name))
      throw new TypeError('Markdown requires a simple filename ending in .md');
    super(options?.fields);
    this.document = new MarkdownDocument(options);
    this.name = name;
    Object.freeze(this);
  }
}
