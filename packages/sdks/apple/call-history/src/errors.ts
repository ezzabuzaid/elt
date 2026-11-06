// Core Data's layout changes between macOS versions; reading one we have not
// verified would misplace calls and their participants.
export class CallHistorySchemaError extends Error {
  override name = 'CallHistorySchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The call history store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
