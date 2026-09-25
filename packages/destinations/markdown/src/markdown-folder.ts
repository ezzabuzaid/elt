import { Target } from 'elt';
import { MarkdownDocument } from './markdown-document.ts';
import type { MarkdownFile } from './markdown-file.ts';

export class MarkdownFolder extends Target {
  static readonly markerName = '.mac-elt-markdown';
  static readonly marker = 'mac-elt MarkdownFolder v3\n';
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

  // The marker file also records the folder's writer.
  static markerFor(writer: string): string {
    return `${MarkdownFolder.marker}${writer}\n`;
  }

  static writer(marker: string): string {
    if (!marker.startsWith(MarkdownFolder.marker) || !marker.endsWith('\n'))
      throw new TypeError('Refusing to replace an unmanaged Markdown folder');
    return marker.slice(MarkdownFolder.marker.length, -1);
  }
}
