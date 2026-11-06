// Mail's store holds something this reader does not know how to read: a
// layout or value Mail has changed.
export class MailSchemaError extends Error {
  override name = 'MailSchemaError';
}

export class MailChangingError extends Error {
  override name = 'MailChangingError';
}
