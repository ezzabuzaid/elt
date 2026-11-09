// A pass whose bundle is missing, or whose pass.json or strings this reader
// cannot decode. Wallet keeps every pass it lists with its bundle, so the
// read fails rather than leave the pass out.
export class PassBundleError extends Error {
  override name = 'PassBundleError';

  constructor(id: string, directory: string, cause: unknown) {
    super(
      `The bundle of pass ${id} at ${directory} cannot be read: ${Error.isError(cause) ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
