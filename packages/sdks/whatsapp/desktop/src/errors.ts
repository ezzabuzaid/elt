export class WhatsAppUnavailableError extends Error {
  override name = 'WhatsAppUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The WhatsApp store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security, and open WhatsApp once so it creates its stores.`,
      { cause },
    );
  }
}

// WhatsApp changes its stores between releases; reading one we have not
// verified would misplace messages and the people in them.
export class WhatsAppSchemaError extends Error {
  override name = 'WhatsAppSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The WhatsApp store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
