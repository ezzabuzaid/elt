// Books changes its stores between releases; reading one we have not
// verified would silently misplace fields.
export class BooksSchemaError extends Error {
  override name = 'BooksSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Books store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
