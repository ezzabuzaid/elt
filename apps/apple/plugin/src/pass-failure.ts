import type { FailureType } from '@workspace/elt';

// A pass's error, followed by what the user can grant only when granting it
// is what fixes the failure.
export const passFailure = (
  {
    error,
    failureType,
  }: { readonly error: string; readonly failureType: FailureType },
  permissions: string,
): string => (failureType === 'config' ? `${error} ${permissions}` : error);
