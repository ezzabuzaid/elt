// A browser's Local State that is not the JSON object Chromium writes, with
// its profiles under profile.info_cache.
export class LocalStateFormatError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(
      `${path} is not the Local State Chromium writes: it holds no profile.info_cache.`,
      options,
    );
    this.name = 'LocalStateFormatError';
    this.path = path;
  }
}
