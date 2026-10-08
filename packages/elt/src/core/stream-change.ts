import { isDeepStrictEqual } from 'node:util';

// The declarations that say how a stream's records are identified, read and
// deleted. Changing one changes what the stored rows mean, so their copy
// cannot carry on from its checkpoint. Airbyte pauses a connection on the
// same kind of change, a removed primary key or cursor, and asks the user to
// refresh or clear.
const declarations = [
  'name',
  'primaryKey',
  'partitionKey',
  'supportedSyncModes',
  'supportsFileTransfer',
  'sourceDefinedCursor',
  'emitsDeletes',
  'expiresBy',
] as const;

// A copy's stream changed one of its declarations since its checkpoint was
// saved. The host decides what happens to the stored rows: a reset keeps them
// and loads on from no checkpoint, a clear drops them.
export class StreamChangeError extends TypeError {
  override name = 'StreamChangeError';

  constructor(id: string, changed: readonly string[]) {
    super(
      `Stream of copy ${id} changed its ${changed.join(', ')}; reset the copy to keep its rows, or clear it to drop them`,
    );
  }
}

// The declarations a stream changed between two of its shapes, as a
// checkpoint binding keeps them. Any other change, to its fields and their
// types, is one the destination evolves its target to.
export function changedDeclarations(
  saved: unknown,
  current: unknown,
): string[] {
  return declarations.filter(
    (declaration) =>
      !isDeepStrictEqual(
        Reflect.get(Object(saved), declaration),
        Reflect.get(Object(current), declaration),
      ),
  );
}
