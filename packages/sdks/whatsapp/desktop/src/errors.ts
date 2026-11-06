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
