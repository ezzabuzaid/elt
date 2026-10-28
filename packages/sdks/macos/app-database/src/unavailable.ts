import { UnavailableError } from '@zukhruf/sqlite-data-version';

export type UnavailableErrorClass = new (path: string, cause: unknown) => Error;

// The SDK's own class names the grant the user must give; the package's error
// stays reachable as its cause.
export function readOrUnavailable<T>(
  path: string,
  unavailable: UnavailableErrorClass,
  read: () => T,
): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof UnavailableError) throw new unavailable(path, error);
    throw error;
  }
}
