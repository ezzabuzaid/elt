import type { FileContent } from './file-content.ts';

// Owns attachment bytes, independently of the destination that holds references.
// Each scope belongs to one target field. Never remove another scope's objects.
export abstract class FileStorage {
  abstract readonly identity: string;

  // What a reference returned by save() is, for readers of the field holding it.
  abstract readonly reference: string;

  // Resolves only after the complete object is published. Retries must reuse
  // the reference, and new content must not overwrite a referenced object.
  // Call flush before committing rows that reference these saves.
  abstract save(scope: string, content: FileContent): Promise<string>;

  // Makes this scope's completed saves durable before their rows commit.
  // Safe to repeat, including for a scope with no saves.
  abstract flush(scope: string): Promise<void>;

  // Reconciles this scope against the destination's committed references,
  // including objects left by an interrupted save, rejected row or failed run.
  abstract retain(
    scope: string,
    references: ReadonlySet<string>,
  ): Promise<void>;
}
