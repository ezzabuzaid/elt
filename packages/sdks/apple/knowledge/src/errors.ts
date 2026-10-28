export class KnowledgeUnavailableError extends Error {
  override name = 'KnowledgeUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `knowledgeC at ${path} cannot be read. Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`,
      { cause },
    );
  }
}
