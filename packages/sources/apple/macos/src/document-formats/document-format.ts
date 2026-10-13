import type { FileHead } from './file-head.ts';

// One kind of document MacOSDocumentParser turns into text.
export abstract class DocumentFormat {
  protected abstract readonly extensions: readonly string[];

  // The format's magic number. Some files carry no usable extension, such as
  // Messages' GroupPhotoImage or pluginPayloadAttachment.
  protected abstract hasSignature(head: FileHead): boolean;

  supports(extension: string, head: FileHead): boolean {
    return this.extensions.includes(extension) || this.hasSignature(head);
  }

  // null means the file holds no text this format can represent.
  abstract text(path: string): Promise<string | null>;
}
