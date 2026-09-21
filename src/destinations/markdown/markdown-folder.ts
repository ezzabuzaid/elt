import { Target } from '../../core/target.ts';
import { MarkdownDocument } from './markdown-document.ts';
import type { MarkdownFile } from './markdown-file.ts';

export class MarkdownFolder extends Target {
  static readonly markerName = '.mac-elt-markdown';
  static readonly marker = 'mac-elt MarkdownFolder v2\n';
  readonly document: MarkdownDocument;

  constructor(
    readonly name: string,
    options?: ConstructorParameters<typeof MarkdownFile>[1],
  ) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name))
      throw new TypeError('Markdown requires a simple folder name');
    super(options?.fields);
    this.document = new MarkdownDocument(options);
    Object.freeze(this);
  }
}
