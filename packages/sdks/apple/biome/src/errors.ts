export class BiomeUnavailableError extends Error {
  override name = 'BiomeUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Biome's store at ${path} cannot be read. Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`,
      { cause },
    );
  }
}

// macOS changes Biome's device list between releases; reading a layout this
// reader has not verified would silently misplace fields.
export class BiomeSchemaError extends Error {
  override name = 'BiomeSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `Biome's device list at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
