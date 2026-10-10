export class WalletUnavailableError extends Error {
  override name = 'WalletUnavailableError';

  constructor(path: string, cause: unknown) {
    super(`The Wallet store at ${path} cannot be read.`, { cause });
  }
}

// passd's layout changes between macOS versions; reading one we have not
// verified would misplace when passes were added or archived.
export class WalletSchemaError extends Error {
  override name = 'WalletSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Wallet store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}

// A pass whose bundle is missing, or whose pass.json or strings this reader
// cannot decode. Wallet keeps every pass it lists with its bundle, so the
// read fails rather than leave the pass out.
export class PassBundleError extends Error {
  override name = 'PassBundleError';

  constructor(id: string, directory: string, cause: unknown) {
    super(
      `The bundle of pass ${id} at ${directory} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
