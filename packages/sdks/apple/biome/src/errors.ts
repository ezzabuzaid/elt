export class BiomeUnavailableError extends Error {
  override name = 'BiomeUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Biome's store at ${path} cannot be read. Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`,
      { cause },
    );
  }
}
