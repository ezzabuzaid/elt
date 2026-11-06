// The store's layout changes between macOS releases; reading one we have not
// verified would silently misplace fields.
export class ContactsSchemaError extends Error {
  override name = 'ContactsSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Contacts store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
