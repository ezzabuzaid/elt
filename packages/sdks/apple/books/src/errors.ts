export class BooksUnavailableError extends Error {
  override name = 'BooksUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Books data at ${path} cannot be read. Open Books once so it creates its stores; if they exist, allow the process that runs the export Full Disk Access in System Settings > Privacy & Security. Books does not need to be open.`,
      { cause },
    );
  }
}

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
