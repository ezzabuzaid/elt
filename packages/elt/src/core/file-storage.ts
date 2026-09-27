import type { FileContent } from './file-content.ts';

// Owns attachment bytes, independently of the destination that holds references.
// Each scope belongs to one target field. Never remove another scope's objects.
export abstract class FileStorage {
  abstract readonly identity: string;

  // Resolves only after the complete object is published. Retries must reuse
  // the reference, and new content must not overwrite a referenced object.
  abstract save(scope: string, content: FileContent): Promise<string>;

  // Reconciles this scope against the destination's committed references,
  // including objects left by an interrupted save, rejected row or failed run.
  abstract retain(
    scope: string,
    references: ReadonlySet<string>,
  ): Promise<void>;
}
