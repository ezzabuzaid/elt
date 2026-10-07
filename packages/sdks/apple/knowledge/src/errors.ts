export class KnowledgeUnavailableError extends Error {
  override name = 'KnowledgeUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `knowledgeC at ${path} cannot be read. Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`,
      { cause },
    );
  }
}

// macOS changes knowledgeC between releases; reading a layout this reader has
// not verified would silently misplace fields.
export class KnowledgeSchemaError extends Error {
  override name = 'KnowledgeSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `knowledgeC at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
