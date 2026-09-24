// The HTTP status of a failed Google call, from a GaxiosError or a stub.
export function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const status: unknown = Reflect.get(error, 'status');
  if (typeof status === 'number') return status;
  const response: unknown = Reflect.get(error, 'response');
  if (response === null || typeof response !== 'object') return undefined;
  const code: unknown = Reflect.get(response, 'status');
  return typeof code === 'number' ? code : undefined;
}

// A 403 that means the request itself is misconfigured (API disabled, a scope
// missing from the grant) rather than that this user may not read the file.
export function isConfigurationError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const response: unknown = Reflect.get(error, 'response');
  const body =
    response !== null && typeof response === 'object'
      ? JSON.stringify(Reflect.get(response, 'data') ?? '')
      : '';
  return /accessNotConfigured|SERVICE_DISABLED|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(
    `${body} ${error instanceof Error ? error.message : ''}`,
  );
}

// Google's own explanation of a failed call, falling back to the error text.
export function messageOf(error: unknown): string {
  const response: unknown =
    error !== null && typeof error === 'object'
      ? Reflect.get(error, 'response')
      : undefined;
  const body: unknown =
    response !== null && typeof response === 'object'
      ? Reflect.get(response, 'data')
      : undefined;
  const failure: unknown =
    body !== null && typeof body === 'object'
      ? Reflect.get(body, 'error')
      : undefined;
  const message: unknown =
    failure !== null && typeof failure === 'object'
      ? Reflect.get(failure, 'message')
      : undefined;
  if (typeof message === 'string' && message) return message;
  return error instanceof Error ? error.message : String(error);
}
